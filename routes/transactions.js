const { createDisposalFeeSnapshot } = require('../lib/performance-fee-policy');
const { InputError, NotFoundError, ConflictError, handleApiError } = require('../lib/api-errors');

function registerTransactionRoutes(app, deps, utils) {
  const { readDb, writeDb, getState, ensureIndexCache,
    isValidDate, normalizeRemark, randomUUID } = deps;
  const { toFiniteNumber, isSundayDate, validateValuationDate, calculateLedgerState,
    findLedgerIssue, rejectLedgerIssue, rejectLockedPeriod, BALANCE_TOLERANCE,
    peekEventSequence, commitEventSequence } = utils;

app.get('/api/state', (req, res, next) => {
  try {
    const state = getState();
    res.json({ success: true, data: state });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 2. 录入出入金记录
app.post('/api/transaction', (req, res, next) => {
  try {
    const { member, type, amount, cnhAmount, date, remark } = req.body;
    const db = readDb();
    if (date) rejectLockedPeriod(db, date);

    const memberObj = db.members.find(m => m.id === member);
    if (!memberObj) {
      throw new InputError('无效的家庭成员');
    }
    if (memberObj.roles?.lp === false) {
      throw new InputError('只有具有LP身份的成员可以登记出入金。');
    }
    if (!['deposit', 'withdraw'].includes(type)) {
      throw new InputError('交易类型必须为入金(deposit)或出金(withdraw)');
    }
    const parsedAmount = toFiniteNumber(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new InputError('金额必须大于 0');
    }

    // 处理人民币金额手动输入
    let parsedCnhAmount = undefined;
    if (cnhAmount !== undefined && cnhAmount !== null && cnhAmount !== '') {
      parsedCnhAmount = toFiniteNumber(cnhAmount);
      if (!Number.isFinite(parsedCnhAmount) || parsedCnhAmount <= 0) {
        throw new InputError('人民币金额必须大于 0');
      }
    } else {
      parsedCnhAmount = parsedAmount * (db.cnhRate || 7.2);
    }

    if (!date) {
      throw new InputError('日期不能为空');
    }

    if (!isValidDate(date)) {
      throw new InputError('日期必须是有效的 YYYY-MM-DD。');
    }
    if (!isSundayDate(date)) {
      throw new InputError('出入金仅在周日办理，交易日期必须为周日。');
    }
    const normalizedRemark = normalizeRemark(remark);
    const newEvent = {
      id: 'tx_' + randomUUID(), // [Fix #4] 使用 crypto.randomUUID() 替代 Math.random，消除碰撞风险
      type,
      member,
      amount: parsedAmount,
      cnhAmount: parsedCnhAmount,
      date,
      remark: normalizedRemark,
      createdAt: Date.now(),
      sequenceNumber: peekEventSequence(db)
    };
    const performanceFeeSnapshot = type === 'withdraw'
      ? createDisposalFeeSnapshot(db.performanceFee, db.members)
      : null;
    if (performanceFeeSnapshot) newEvent.performanceFee = performanceFeeSnapshot;

    db.events.push(newEvent);
    const validationState = calculateLedgerState(db, {
      autoFullExitEventIds: type === 'withdraw' ? [newEvent.id] : []
    });
    const computedEvent = validationState.events.find(event => event.id === newEvent.id);
    if (type === 'withdraw') {
      const availableValue = computedEvent?._accountValueBefore || 0;
      if (parsedAmount > availableValue + BALANCE_TOLERANCE) {
        throw new InputError(`余额不足！${memberObj.name}在 ${date} 交易前的资产为 $${availableValue.toFixed(2)}，无法提取 $${parsedAmount.toFixed(2)}`);
      }
    }
    const ledgerIssue = findLedgerIssue(db, validationState);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);
    if (computedEvent?._fullExit) {
      newEvent.fullExit = true;
      newEvent.requestedGrossAmount = parsedAmount;
      newEvent.amount = computedEvent._actualAmount;
      newEvent.cnhAmount = computedEvent._cnhAmountComputed;
    }
    db.lastEventSequence = newEvent.sequenceNumber;
    writeDb(db);
    commitEventSequence(newEvent.sequenceNumber);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '交易记录登记成功', data: newEvent });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 3. 录入估值更新记录
app.post('/api/valuation', (req, res, next) => {
  try {
    const { totalNAV, date, remark } = req.body;

    const parsedNAV = toFiniteNumber(totalNAV);
    if (!Number.isFinite(parsedNAV) || parsedNAV <= 0) {
      throw new InputError('资产估值金额必须大于 0，零净值会导致后续份额无法定价。');
    }
    if (!date) {
      throw new InputError('日期不能为空');
    }

    const db = readDb();

    if (!isValidDate(date)) {
      throw new InputError('日期必须是有效的 YYYY-MM-DD。');
    }
    const valuationDateError = validateValuationDate(date);
    if (valuationDateError) throw new InputError(valuationDateError);
    rejectLockedPeriod(db, date);
    const normalizedRemark = normalizeRemark(remark, '定期净值估值更新');
    const newEvent = {
      id: 'val_' + randomUUID(), // [Fix #4] 使用 crypto.randomUUID() 替代 Math.random，消除碰撞风险
      type: 'valuation',
      totalNAV: parsedNAV,
      date,
      remark: normalizedRemark,
      createdAt: Date.now(),
      sequenceNumber: peekEventSequence(db)
    };

    db.events.push(newEvent);
    const validationState = calculateLedgerState(db);
    const ledgerIssue = findLedgerIssue(db, validationState);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);
    db.lastEventSequence = newEvent.sequenceNumber;
    writeDb(db);
    commitEventSequence(newEvent.sequenceNumber);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '资产估值更新成功', data: newEvent });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 3.5. 内部份额转让划转
app.post('/api/transfer', (req, res, next) => {
  try {
    const { fromMember, toMember, amount, cnhRate, date, remark } = req.body;
    const db = readDb();
    if (date) rejectLockedPeriod(db, date);

    if (fromMember === toMember) {
      throw new InputError('出让方与受让方不能为同一成员');
    }

    const fromObj = db.members.find(m => m.id === fromMember);
    const toObj = db.members.find(m => m.id === toMember);
    if (!fromObj || !toObj) {
      throw new InputError('无效的转让成员');
    }
    if (fromObj.roles?.lp === false || toObj.roles?.lp === false) {
      throw new InputError('普通投资份额只能在LP成员之间转让。');
    }

    const parsedAmount = toFiniteNumber(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      throw new InputError('转让金额必须大于 0');
    }

    const parsedRate = toFiniteNumber(cnhRate);
    if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
      throw new InputError('受让汇率必须大于 0');
    }

    if (!date) {
      throw new InputError('日期不能为空');
    }

    if (!isValidDate(date)) {
      throw new InputError('日期必须是有效的 YYYY-MM-DD。');
    }
    if (!isSundayDate(date)) {
      throw new InputError('内部份额转让仅在周日办理，划转日期必须为周日。');
    }
    const normalizedRemark = normalizeRemark(remark);
    const newEvent = {
      id: 'tf_' + randomUUID(), // [Fix #4] 使用 crypto.randomUUID() 替代 Math.random，消除碰撞风险
      type: 'transfer',
      fromMember,
      toMember,
      amount: parsedAmount,
      cnhRate: parsedRate,
      cnhAmount: parsedAmount * parsedRate,
      date,
      remark: normalizedRemark,
      createdAt: Date.now(),
      sequenceNumber: peekEventSequence(db)
    };
    const performanceFeeSnapshot = createDisposalFeeSnapshot(db.performanceFee, db.members);
    if (performanceFeeSnapshot) newEvent.performanceFee = performanceFeeSnapshot;

    db.events.push(newEvent);
    const validationState = calculateLedgerState(db, {
      autoFullExitEventIds: [newEvent.id]
    });
    const computedEvent = validationState.events.find(event => event.id === newEvent.id);
    const availableValue = computedEvent?._accountValueBefore || 0;
    if (parsedAmount > availableValue + BALANCE_TOLERANCE) {
      throw new InputError(`出让方余额不足！${fromObj.name}在 ${date} 交易前的资产为 $${availableValue.toFixed(2)}，无法划转 $${parsedAmount.toFixed(2)}`);
    }
    const ledgerIssue = findLedgerIssue(db, validationState);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);
    if (computedEvent?._fullExit) {
      newEvent.fullExit = true;
      newEvent.requestedGrossAmount = parsedAmount;
      newEvent.amount = computedEvent._actualAmount;
      newEvent.cnhAmount = computedEvent._cnhAmountComputed;
    }
    db.lastEventSequence = newEvent.sequenceNumber;
    writeDb(db);
    commitEventSequence(newEvent.sequenceNumber);

    // 静默后台触发指数同步
    ensureIndexCache([date]);

    res.json({ success: true, message: '内部份额转让登记成功', data: newEvent });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

app.delete('/api/event/:id', (req, res, next) => {
  try {
    const eventId = req.params.id;
    const db = readDb();

    const index = db.events.findIndex(e => e.id === eventId);
    if (index === -1) {
      throw new NotFoundError('未找到该条记录');
    }
    if (['performance_settlement', 'performance_settlement_reversal'].includes(db.events[index].type)) {
      throw new ConflictError('业绩结算及冲销记录不可直接删除。');
    }
    rejectLockedPeriod(db, db.events[index].date);

    const removedEvent = db.events.splice(index, 1)[0];
    const ledgerIssue = findLedgerIssue(db);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);
    writeDb(db);

    res.json({
      success: true,
      message: '记录已成功删除，系统账目已自动完成重新计算。',
      data: removedEvent
    });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});

// 4.5. 修改事件（支持交易/估值在线修改，一键级联重算）
app.put('/api/event/:id', (req, res, next) => {
  try {
    const eventId = req.params.id;
    const db = readDb();

    const event = db.events.find(e => e.id === eventId);
    if (!event) {
      throw new NotFoundError('未找到该条记录');
    }
    if (['performance_settlement', 'performance_settlement_reversal'].includes(event.type)) {
      throw new ConflictError('业绩结算及冲销记录不可直接修改。');
    }
    const wasFullExit = event.fullExit === true;
    const previousAmount = event.amount;
    const previousRequestedGrossAmount = event.requestedGrossAmount;
    const previousCnhAmount = event.cnhAmount;
    if (event.type === 'withdraw' || event.type === 'transfer') {
      delete event.fullExit;
      delete event.requestedGrossAmount;
      if (wasFullExit && req.body?.amount === undefined && previousRequestedGrossAmount !== undefined) {
        event.amount = previousRequestedGrossAmount;
        if (previousAmount > 0 && previousCnhAmount !== undefined) {
          event.cnhAmount = previousCnhAmount * previousRequestedGrossAmount / previousAmount;
        }
      }
    }
    rejectLockedPeriod(db, event.date);
    const requestedDate = req.body?.date;
    if (requestedDate !== undefined) {
      if (!isValidDate(requestedDate)) {
        throw new InputError('日期必须是有效的 YYYY-MM-DD。');
      }
      rejectLockedPeriod(db, requestedDate);
    }

    if (event.type === 'deposit' || event.type === 'withdraw') {
      const { member, amount, cnhAmount, date, remark } = req.body;

      if (member !== undefined) {
        const memberObj = db.members.find(m => m.id === member);
        if (!memberObj) {
          throw new InputError('无效的家庭成员');
        }
        if (memberObj.roles?.lp === false) {
          throw new InputError('只有具有LP身份的成员可以登记出入金。');
        }
        event.member = member;
      }

      if (amount !== undefined) {
        const parsedAmount = toFiniteNumber(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          throw new InputError('美元金额必须大于 0');
        }
        event.amount = parsedAmount;
        if (cnhAmount === undefined) {
          const effectiveRate = previousAmount > 0 && Number.isFinite(previousCnhAmount)
            ? previousCnhAmount / previousAmount
            : (db.cnhRate || 7.2);
          event.cnhAmount = parsedAmount * effectiveRate;
        }
      }

      if (cnhAmount === null || cnhAmount === '') {
        // Explicit clearing requests current-rate conversion. Omission above
        // preserves the original transaction's exchange rate instead.
        event.cnhAmount = event.amount * (db.cnhRate || 7.2);
      } else if (cnhAmount !== undefined) {
        const parsedCnh = toFiniteNumber(cnhAmount);
        if (!Number.isFinite(parsedCnh) || parsedCnh <= 0) {
          throw new InputError('人民币金额必须大于 0');
        }
        event.cnhAmount = parsedCnh;
      }

      if (date !== undefined) {
        if (!isValidDate(date)) throw new InputError('日期必须是有效的 YYYY-MM-DD。');
        if (!isSundayDate(date)) throw new InputError('出入金仅在周日办理，交易日期必须为周日。');
        event.date = date;
      }

      if (remark !== undefined) {
        event.remark = normalizeRemark(remark);
      }

    } else if (event.type === 'valuation') {
      const { totalNAV, date, remark } = req.body;

      if (totalNAV !== undefined) {
        const parsedNAV = toFiniteNumber(totalNAV);
        if (!Number.isFinite(parsedNAV) || parsedNAV <= 0) {
          throw new InputError('资产估值金额必须大于 0，零净值会导致后续份额无法定价。');
        }
        event.totalNAV = parsedNAV;
      }

      if (date !== undefined) {
        if (!isValidDate(date)) throw new InputError('日期必须是有效的 YYYY-MM-DD。');
        const valuationDateError = validateValuationDate(date);
        if (valuationDateError) throw new InputError(valuationDateError);
        event.date = date;
      }

      if (remark !== undefined) {
        event.remark = normalizeRemark(remark);
      }
    } else if (event.type === 'transfer') {
      const { fromMember, toMember, amount, cnhRate, date, remark } = req.body;

      if (fromMember !== undefined) {
        const fromObj = db.members.find(m => m.id === fromMember);
        if (!fromObj) throw new InputError('无效的出让家庭成员');
        if (fromObj.roles?.lp === false) throw new InputError('普通投资份额只能在LP成员之间转让。');
        event.fromMember = fromMember;
      }

      if (toMember !== undefined) {
        const toObj = db.members.find(m => m.id === toMember);
        if (!toObj) throw new InputError('无效的受让家庭成员');
        if (toObj.roles?.lp === false) throw new InputError('普通投资份额只能在LP成员之间转让。');
        event.toMember = toMember;
      }

      if (event.fromMember === event.toMember) {
        throw new InputError('出让方与受让方不能为同一成员');
      }

      if (amount !== undefined) {
        const parsedAmount = toFiniteNumber(amount);
        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
          throw new InputError('转让金额必须大于 0');
        }
        event.amount = parsedAmount;
      }

      if (cnhRate !== undefined) {
        const parsedRate = toFiniteNumber(cnhRate);
        if (!Number.isFinite(parsedRate) || parsedRate <= 0) {
          throw new InputError('受让汇率必须大于 0');
        }
        event.cnhRate = parsedRate;
      }

      // 重新计算 cnhAmount
      event.cnhAmount = event.amount * (event.cnhRate || db.cnhRate || 7.2);

      if (date !== undefined) {
        if (!isValidDate(date)) throw new InputError('日期必须是有效的 YYYY-MM-DD。');
        if (!isSundayDate(date)) throw new InputError('内部份额转让仅在周日办理，划转日期必须为周日。');
        event.date = date;
      }

      if (remark !== undefined) {
        event.remark = normalizeRemark(remark);
      }

    }

    const validationState = calculateLedgerState(db, {
      autoFullExitEventIds: event.type === 'withdraw' || event.type === 'transfer'
        ? [event.id]
        : []
    });
    const computedEvent = validationState.events.find(item => item.id === event.id);
    if (event.type === 'withdraw' || event.type === 'transfer') {
      const actualAmount = computedEvent
        ? (computedEvent._grossAmount ?? computedEvent._actualAmount ?? 0)
        : 0;
      if (actualAmount + BALANCE_TOLERANCE < event.amount) {
        throw new InputError(`${event.type === 'withdraw' ? '余额不足' : '出让方余额不足'}：该修改会导致实际可${event.type === 'withdraw' ? '出金' : '转让'} $${actualAmount.toFixed(2)}，低于填写金额 $${event.amount.toFixed(2)}`);
      }
      if (computedEvent?._fullExit) event.fullExit = true;
    }

    const ledgerIssue = findLedgerIssue(db, validationState);
    if (ledgerIssue) rejectLedgerIssue(ledgerIssue);

    if (event.fullExit === true) {
      event.requestedGrossAmount = event.amount;
      event.amount = computedEvent._actualAmount;
      event.cnhAmount = computedEvent._cnhAmountComputed;
    }

    writeDb(db);

    // 触发指数同步
    if (event.date) ensureIndexCache([event.date]);

    res.json({ success: true, message: '账目记录修改成功，系统已自动重算', data: event });
  } catch (error) {
    handleApiError(error, req, res, next);
  }
});
}

module.exports = { registerTransactionRoutes };
