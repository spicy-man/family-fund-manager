(function () {
  function init({ elements, api, modal, loadAllData, renderMembersEditorList, showToast }) {
    const {
      memberModal, backupModal, formAddMember, newMemberName,
      btnTriggerUpload, fileImport, fileNameLabel, btnConfirmImport
    } = elements;
    const openMembersPanel = () => {
      renderMembersEditorList();
      modal.open(memberModal);
    };
    const openBackupPanel = () => modal.open(backupModal);

    formAddMember.addEventListener('submit', async event => {
      event.preventDefault();
      if (newMemberName.disabled) return;
      const name = newMemberName.value.trim();
      if (!name) return;
      try {
        await api.addMember(name);
        showToast(`家庭成员【${name}】添加成功`, 'success');
        newMemberName.value = '';
        await loadAllData();
        renderMembersEditorList();
      } catch (error) {
        showToast(error.message, 'error');
      }
    });

    btnTriggerUpload.addEventListener('click', () => fileImport.click());
    fileImport.addEventListener('change', event => {
      const file = event.target.files[0];
      fileNameLabel.textContent = file ? file.name : '未选择任何文件';
      if (file) btnConfirmImport.removeAttribute('disabled');
      else btnConfirmImport.setAttribute('disabled', 'true');
    });
    btnConfirmImport.addEventListener('click', async () => {
      const file = fileImport.files[0];
      if (!file) return;
      try {
        btnConfirmImport.setAttribute('disabled', 'true');
        const result = await api.importBackup(file);
        showToast(result.message || 'ZIP 快照恢复成功！账目和系统配置均已覆盖。', result.warnings?.length ? 'warning' : 'success');
        modal.close(backupModal);
        fileImport.value = '';
        fileNameLabel.textContent = '未选择任何文件';
        await loadAllData();
      } catch (error) {
        btnConfirmImport.removeAttribute('disabled');
        showToast('恢复失败，请确认上传了本系统导出的 ZIP 备份：' + error.message, 'error');
      }
    });

    return { openMembersPanel, openBackupPanel };
  }

  window.FundManagementController = { init };
})();
