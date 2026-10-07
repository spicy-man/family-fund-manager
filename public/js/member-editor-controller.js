(function () {
  function create({ elements, api, getMembers, setMembers, getState, checkIfDark, loadAllData, showToast,
    ui: { escapeHtml, getAvatarText, getMemberAvatarColor } }) {
    const { gpSetupWarning, elMembersEditList } = elements;
    let savingNames = false;
    let activeWrites = 0;
    let renderedIds = [];
    function render({ discardDrafts = [], confirmedSave = false } = {}) {
      if (savingNames && !confirmedSave) return;
      const drafts = new Map();
      for (const id of renderedIds) {
        if (discardDrafts.includes(id)) continue;
        const name = document.getElementById('member-name-input-' + id);
        const number = document.getElementById('member-id-input-' + id);
        if (name?.style.display === 'block' || number?.style.display === 'block') {
          drafts.set(id, { name: name?.value, number: number?.value,
            nameOpen: name?.style.display === 'block', numberOpen: number?.style.display === 'block' });
        }
      }
      const membersList = getMembers();
      renderedIds = membersList.map(member => member.id);
      const appState = getState();
      if (gpSetupWarning) gpSetupWarning.hidden = membersList.some(member => member.primaryGp);
      if (membersList.length === 0) {
        elMembersEditList.innerHTML = `
          <div style="text-align: center; color: var(--color-text-muted); padding: 20px; font-size: 0.8rem;">
            当前家庭无成员数据，请输入名字创建
          </div>
        `;
        return;
      }

      elMembersEditList.innerHTML = membersList.map((m, idx) => {
        const shortName = escapeHtml(getAvatarText(m.name));

        const isDark = checkIfDark();
        const { background: cardColor, color: cardTextColor } = getMemberAvatarColor(m.id || m.name, isDark, idx);

        // 检查成员是否拥有交易历史
        const hasTx = appState.events.some(e =>
          e.member === m.id || e.fromMember === m.id || e.toMember === m.id
        );

        return `
          <div class="member-edit-item${m.primaryGp ? ' is-primary-gp' : ''}" id="member-edit-item-${m.id}">
            <div class="member-edit-left">
              <div class="member-edit-avatar" style="background: ${cardColor}; color: ${cardTextColor};">${shortName}</div>
              <div class="member-edit-identity">
                <div class="member-identity-heading"><span class="member-edit-name" id="member-name-span-${m.id}" title="双击或点击右侧笔头重命名">${escapeHtml(m.name)}</span>
                <input type="text" class="input-rename" id="member-name-input-${m.id}" value="${escapeHtml(m.name)}" style="display: none;">
                <span class="member-role-badge">LP</span></div>
                <div class="member-id-editor">
                  <span class="member-id-label">编号</span>
                  <span class="member-id-value" id="member-id-value-${m.id}">${escapeHtml(m.id)}</span>
                  <input class="member-id-input" id="member-id-input-${m.id}" value="${escapeHtml(m.id)}" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" spellcheck="false" style="display:none" aria-label="${escapeHtml(m.name)}的成员编号">
                  <button type="button" class="member-id-edit" id="member-id-save-${m.id}" aria-label="编辑${escapeHtml(m.name)}的编号">编辑</button>
                </div>
              </div>
              <label class="primary-gp-choice" title="设为全系统唯一的主 GP">
                <input type="radio" name="primary-gp" id="member-primary-gp-${m.id}" ${m.primaryGp ? 'checked' : ''}>
                <span class="primary-gp-radio"></span>
                <span>主 GP</span>
              </label>
            </div>
            <div class="member-edit-actions">
              <button class="btn-rename-save" id="btn-rename-edit-${m.id}" title="重命名成员" style="color: var(--color-cyan);">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
              </button>
              <button class="btn-rename-save" id="btn-rename-save-${m.id}" title="保存修改" style="color: var(--color-green); display: none;">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </button>
              <button class="btn-delete" id="btn-member-del-${m.id}" title="${hasTx ? '已有出入金或转让记录，禁止删除' : '移除该成员'}" ${hasTx ? 'disabled style="opacity: 0.25; cursor: not-allowed;"' : ''}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
          </div>
        `;
      }).join('');

      // 事件绑定
      membersList.forEach(m => {
        const span = document.getElementById(`member-name-span-${m.id}`);
        const input = document.getElementById(`member-name-input-${m.id}`);
        const btnEdit = document.getElementById(`btn-rename-edit-${m.id}`);
        const btnSave = document.getElementById(`btn-rename-save-${m.id}`);
        const idInput = document.getElementById(`member-id-input-${m.id}`);
        const idSave = document.getElementById(`member-id-save-${m.id}`);
        const draft = drafts.get(m.id);
        input.value = draft?.nameOpen ? draft.name : m.name;
        input.style.display = draft?.nameOpen ? 'block' : 'none';
        span.style.display = draft?.nameOpen ? 'none' : 'block';
        btnEdit.style.display = draft?.nameOpen ? 'none' : 'grid';
        btnSave.style.display = draft?.nameOpen ? 'grid' : 'none';
        if (idInput) {
          idInput.value = draft?.numberOpen ? draft.number : m.id;
          idInput.style.display = draft?.numberOpen ? 'block' : 'none';
          idSave.style.display = draft?.numberOpen ? 'none' : 'inline';
          document.getElementById('member-id-value-' + m.id).style.display = draft?.numberOpen ? 'none' : 'inline';
        }
        const btnDel = document.getElementById(`btn-member-del-${m.id}`);
        const primaryGp = document.getElementById(`member-primary-gp-${m.id}`);

        const saveRoles = async () => {
          if (savingNames || activeWrites) return;
          activeWrites++;
          try {
            await api.updateMemberRoles(m.id, { gp: true, primaryGp: true });
            await loadAllData();
            render();
          } catch (error) {
            showToast(error.message, 'error');
            render();
          } finally { activeWrites--; }
        };
        primaryGp.addEventListener('change', saveRoles);

        const startEdit = () => {
          if (savingNames) return;
          span.style.display = 'none';
          btnEdit.style.display = 'none';
          input.style.display = 'block';
          btnSave.style.display = 'grid';
          input.focus();
          input.select();
        };

        const saveEdit = async () => {
          if (savingNames || activeWrites) return;
          const newName = input.value.trim();
          const newId = idInput?.value.trim() ?? m.id;
          if (!newId) { showToast('成员编号不能为空', 'error'); return; }
          if (!newName) {
            showToast('成员姓名不能为空', 'error');
            return;
          }
          if (newName === m.name && newId === m.id) {
            // 无改动取消
            cancelEdit();
            return;
          }
          activeWrites++;
          try {
            await api.updateMember(m.id, newName, newId === m.id ? undefined : newId);
            // Keep confirmed identifiers available even if the subsequent refresh fails.
            setMembers?.(getMembers().map(member => member.id === m.id
              ? { ...member, id: newId, name: newName } : member));
            render({ discardDrafts: [m.id] });
            showToast('成员姓名与编号已保存', 'success');
            try { await loadAllData(); } catch (error) { showToast('修改已保存，刷新失败: ' + error.message, 'error'); }
            render();
          } catch (err) {
            showToast(err.message, 'error');
          } finally { activeWrites--; }
        };

        const cancelEdit = () => {
          if (savingNames) return;
          span.style.display = 'block';
          btnEdit.style.display = 'grid';
          input.style.display = 'none';
          btnSave.style.display = 'none';
          input.value = m.name;
        };

        span.addEventListener('dblclick', startEdit);
        btnEdit.addEventListener('click', startEdit);
        btnSave.addEventListener('click', saveEdit);
        idSave?.addEventListener('click', () => {
          if (savingNames || activeWrites) return;
          document.getElementById('member-id-value-' + m.id).style.display = 'none';
          idInput.style.display = 'block';
          idSave.style.display = 'none';
          idInput.focus(); idInput.select();
        });

        input.addEventListener('keyup', (e) => {
          if (e.key === 'Enter') saveEdit();
          if (e.key === 'Escape') cancelEdit();
        });

        if (btnDel && !btnDel.disabled) {
          btnDel.addEventListener('click', async () => {
            if (savingNames || activeWrites) return;
            if (confirm(`确定要从系统删除家庭成员【${m.name}】吗？删除后将无法撤销。`)) {
              activeWrites++;
              try {
                await api.deleteMember(m.id);
                showToast(`家庭成员【${m.name}】已移除`, 'success');
                await loadAllData();
                render();
              } catch (err) {
                showToast(err.message, 'error');
              } finally { activeWrites--; }
            }
          });
        }
      });
    }

    async function savePendingNames() {
      if (savingNames || activeWrites) return false;
      const changes = getMembers().flatMap(member => {
        const input = document.getElementById('member-name-input-' + member.id);
        const idInput = document.getElementById('member-id-input-' + member.id);
        const newId = idInput?.value.trim() ?? member.id;
        const name = input && input.style.display !== 'none' ? input.value.trim() : member.name;
        if (name === member.name && newId === member.id) return [];
        return [{ id: member.id, name, newId, previousName: member.name }];
      });
      if (changes.some(change => !change.name)) {
        showToast('成员姓名不能为空', 'error'); return false;
      }
      if (changes.some(change => !change.newId)) { showToast('成员编号不能为空', 'error'); return false; }
      savingNames = true;
      const editor = document.getElementById('member-modal') || elMembersEditList;
      const controls = [...(editor.querySelectorAll?.('input, button') || [])].map(control => ({ control, disabled: control.disabled }));
      controls.forEach(({ control }) => { control.disabled = true; });
      try {
        if (changes.length) {
          const result = await api.updateMembers(changes.map(change => ({
            id: change.id, name: change.name, memberId: change.newId
          })));
          if (Array.isArray(result?.data)) setMembers?.(result.data);
        }
        if (changes.length) {
          // Rebind confirmed identities before any fallible network refresh, including ID swaps.
          render({ discardDrafts: changes.map(change => change.id), confirmedSave: true });
          for (const control of editor.querySelectorAll?.('input, button') || []) {
            if (!controls.some(item => item.control === control)) controls.push({ control, disabled: control.disabled });
            control.disabled = true;
          }
          try { await loadAllData(); } catch (error) { showToast('修改已保存，刷新失败: ' + error.message, 'error'); }
        }
        savingNames = false;
        if (changes.length) render();
        return true;
      } catch (error) {
        showToast(error.message, 'error'); return false;
      } finally {
        savingNames = false;
        controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
      }
    }
    return { render, savePendingNames };
  }
  window.FundMemberEditor = { create };
})();
