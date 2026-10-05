(function () {
  function create({ elements, api, getMembers, getState, checkIfDark, loadAllData, showToast,
    ui: { escapeHtml, getAvatarText, getMemberAvatarColor } }) {
    const { gpSetupWarning, elMembersEditList } = elements;
    function render() {
      const membersList = getMembers();
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
                <span class="member-edit-name" id="member-name-span-${m.id}" title="双击或点击右侧笔头重命名">${escapeHtml(m.name)}</span>
                <input type="text" class="input-rename" id="member-name-input-${m.id}" value="${escapeHtml(m.name)}" style="display: none;">
                <span class="member-role-badge">LP</span>
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
        const btnDel = document.getElementById(`btn-member-del-${m.id}`);
        const primaryGp = document.getElementById(`member-primary-gp-${m.id}`);

        const saveRoles = async () => {
          try {
            await api.updateMemberRoles(m.id, { gp: true, primaryGp: true });
            await loadAllData();
            render();
          } catch (error) {
            showToast(error.message, 'error');
            render();
          }
        };
        primaryGp.addEventListener('change', saveRoles);

        const startEdit = () => {
          span.style.display = 'none';
          btnEdit.style.display = 'none';
          input.style.display = 'block';
          btnSave.style.display = 'inline-flex';
          input.focus();
          input.select();
        };

        const saveEdit = async () => {
          const newName = input.value.trim();
          if (!newName) {
            showToast('成员姓名不能为空', 'error');
            return;
          }
          if (newName === m.name) {
            // 无改动取消
            cancelEdit();
            return;
          }
          try {
            await api.updateMember(m.id, newName);
            showToast(`家庭成员【${m.name}】已成功重命名为【${newName}】`, 'success');
            await loadAllData();
            render();
          } catch (err) {
            showToast(err.message, 'error');
          }
        };

        const cancelEdit = () => {
          span.style.display = 'block';
          btnEdit.style.display = 'inline-flex';
          input.style.display = 'none';
          btnSave.style.display = 'none';
          input.value = m.name;
        };

        span.addEventListener('dblclick', startEdit);
        btnEdit.addEventListener('click', startEdit);
        btnSave.addEventListener('click', saveEdit);

        input.addEventListener('keyup', (e) => {
          if (e.key === 'Enter') saveEdit();
          if (e.key === 'Escape') cancelEdit();
        });

        if (btnDel && !btnDel.disabled) {
          btnDel.addEventListener('click', async () => {
            if (confirm(`确定要从系统删除家庭成员【${m.name}】吗？删除后将无法撤销。`)) {
              try {
                await api.deleteMember(m.id);
                showToast(`家庭成员【${m.name}】已移除`, 'success');
                await loadAllData();
                render();
              } catch (err) {
                showToast(err.message, 'error');
              }
            }
          });
        }
      });
    }

    return { render };
  }
  window.FundMemberEditor = { create };
})();
