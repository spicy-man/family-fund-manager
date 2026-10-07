const { generateMemberId } = require('../lib/member-id');
const { renameMemberIdentifiers } = require('../lib/member-identifiers');
const { DEFAULT_PERFORMANCE_FEE_CONFIG } = require('../lib/performance-fee-policy');

const { InputError, NotFoundError, ConflictError, handleApiError } = require('../lib/api-errors');

function registerMemberRoutes(app, deps) {
  const { readDb, writeDb, readSettlements, normalizeMemberName } = deps;

// 7. 家庭成员增删改 API 路由

// 获取成员列表
app.get('/api/members', (req, res, next) => {
  try {
    const db = readDb();
    res.json({
      success: true,
      data: db.members.map(member => ({
        ...member,
        roles: member.roles || { lp: true, gp: false },
        primaryGp: db.performanceFee?.gpMemberId === member.id
      }))
    });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 新增成员
app.post('/api/members', (req, res, next) => {
  try {
    const { name } = req.body;
    const db = readDb();
    const trimmedName = normalizeMemberName(name);

    if (db.members.some(m => m.name === trimmedName)) {
      throw new InputError('该成员姓名已存在');
    }

    const newMember = {
      id: generateMemberId(deps.getStoredMemberIds?.() || new Set(db.members.map(member => member.id))),
      name: trimmedName,
      roles: { lp: true, gp: false }
    };
    db.members.push(newMember);
    writeDb(db);

    res.json({ success: true, message: '添加新成员成功', data: newMember });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// Validate the final member set before committing all edits together.
app.put('/api/members', (req, res, next) => {
  try {
    const changes = req.body?.changes;
    if (!Array.isArray(changes) || !changes.length) throw new InputError('请提供成员修改列表。');
    const db = deps.readBaseDb?.() ?? readDb();
    const nextMembers = db.members.map(member => ({ ...member }));
    const mapping = {};
    const seen = new Set();
    for (const change of changes) {
      if (!change || seen.has(change.id)) throw new InputError('成员修改列表重复或无效。');
      seen.add(change.id);
      const member = nextMembers.find(item => item.id === change.id);
      if (!member) throw new NotFoundError('未找到该家庭成员');
      const id = change.memberId === undefined ? member.id : change.memberId;
      if (id !== member.id && (typeof id !== 'string' || !/^[0-9]{6}$/.test(id))) {
        throw new InputError('成员编号须为 6 位数字。');
      }
      member.name = normalizeMemberName(change.name);
      if (id !== member.id) mapping[member.id] = id;
    }
    const finalMembers = nextMembers.map(member => ({ ...member,
      id: Object.hasOwn(mapping, member.id) ? mapping[member.id] : member.id }));
    if (new Set(finalMembers.map(member => member.id)).size !== finalMembers.length) {
      throw new InputError('该编号已被本账本其他成员使用。跨账本的同一个人可以使用相同编号。');
    }
    if (new Set(finalMembers.map(member => member.name)).size !== finalMembers.length) {
      throw new InputError('该成员姓名已被使用');
    }
    const result = Object.keys(mapping).length
      ? renameMemberIdentifiers(db, readSettlements(), mapping)
      : { db, ledger: readSettlements() };
    result.db.members = finalMembers;
    deps.writeSnapshot(result.db, deps.readConfig(), result.ledger);
    res.json({ success: true, data: result.db.members.map(member => ({ ...member,
      primaryGp: result.db.performanceFee?.gpMemberId === member.id })) });
  } catch (error) { handleApiError(error, req, res, next); }
});

// 修改成员重命名
app.put('/api/members/:id', (req, res, next) => {
  try {
    const memberId = req.params.id;
    const { name } = req.body;
    const db = readDb();
    const trimmedName = normalizeMemberName(name);

    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      throw new NotFoundError('未找到该家庭成员');
    }

    if (db.members.some((m, idx) => m.name === trimmedName && idx !== memberIndex)) {
      throw new InputError('该成员姓名已被使用');
    }

    const newId = req.body.memberId === undefined ? memberId : req.body.memberId;
    if (newId !== memberId && (typeof newId !== 'string' || !/^[0-9]{6}$/.test(newId))) {
      throw new InputError('成员编号须为 6 位数字。');
    }
    if (newId !== memberId) {
      if (db.members.some(member => member.id === newId)) {
        throw new InputError('该编号已被本账本其他成员使用。跨账本的同一个人可以使用相同编号。');
      }
      const result = renameMemberIdentifiers(deps.readBaseDb?.() ?? db, readSettlements(), { [memberId]: newId });
      result.db.members[memberIndex].name = trimmedName;
      deps.writeSnapshot(result.db, deps.readConfig(), result.ledger);
    } else {
      db.members[memberIndex].name = trimmedName;
      writeDb(db);
    }

    res.json({ success: true, message: '成员姓名修改成功', data: { id: newId, name: trimmedName } });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.put('/api/members/:id/roles', (req, res, next) => {
  try {
    const db = readDb();
    const member = db.members.find(item => item.id === req.params.id);
    if (!member) throw new NotFoundError('未找到该家庭成员');
    db.performanceFee ||= { ...DEFAULT_PERFORMANCE_FEE_CONFIG };
    if (req.body?.gp !== true && req.body?.primaryGp !== true) {
      throw new InputError('系统必须指定且只能指定一位GP。');
    }
    db.performanceFee.gpMemberId = member.id;
    db.members.forEach(item => {
      item.roles = { lp: true, gp: db.performanceFee.gpMemberId === item.id };
    });
    writeDb(db);
    res.json({ success: true, message: '唯一GP已更新。' });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 删除成员（包含出资安全过滤）
app.delete('/api/members/:id', (req, res, next) => {
  try {
    const memberId = req.params.id;
    const db = readDb();

    const memberIndex = db.members.findIndex(m => m.id === memberId);
    if (memberIndex === -1) {
      throw new NotFoundError('未找到该家庭成员');
    }

    if (db.performanceFee?.gpMemberId === memberId) {
      throw new ConflictError('当前GP不能直接删除，请先将GP角色转移给其他成员。');
    }

    // 安全检查：如果该成员已经录入过出入金或参与过转让，则绝对不允许删除
    const hasTransactions = db.events.some(e =>
      e.member === memberId || e.fromMember === memberId || e.toMember === memberId ||
      e.gpMember === memberId || e.performanceFee?.gpMember === memberId
    ) || readSettlements().records.some(record =>
      record.gpMember === memberId || record.lpMembers?.includes(memberId)
    );
    if (hasTransactions) {
      throw new ConflictError('删除失败！该成员已有出入金或转让记录，删除其账号会破坏历史净值计算。若不需要显示该成员，可在无持股时将其更名或保留。');
    }

    const removed = db.members.splice(memberIndex, 1)[0];
    writeDb(db);

    res.json({ success: true, message: `成员【${removed.name}】已成功移除`, data: removed });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});
}

module.exports = { registerMemberRoutes };
