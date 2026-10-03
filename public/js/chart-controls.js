(function () {
  function init({
    elements, chartRenderer, segmentedControl, renderLedger, renderCharts,
    getNavTrendChart, getRenderTrendStats, setActiveTimeSlice
  }) {
    const {
      filterMember, filterType, chkCompNav, chkCompAssets,
      chkCompSp500, chkCompNdx, chkCompCustom, chkCompCustom2
    } = elements;
    const activateSegmentOption = segmentedControl.activate.bind(segmentedControl);

    // 流水筛选
    filterMember.addEventListener('change', renderLedger);
    filterType.addEventListener('change', renderLedger);

    // 对标指数复选框切换监听
    const comparisonDatasetIndexes = new Map([
      [chkCompAssets, 0],
      [chkCompNav, 1],
      [chkCompSp500, 2],
      [chkCompNdx, 3],
      [chkCompCustom, 4],
      [chkCompCustom2, 5]
    ]);

    const updateCompVisibility = event => {
      if (!getNavTrendChart()) return;

      const checkbox = event.currentTarget;
      const datasetIndex = comparisonDatasetIndexes.get(checkbox);
      const visible = checkbox.checked;
      const isAssets = datasetIndex === 0;

      // The asset axis changes the chart layout. Settle that layout without
      // animation first, then fade the dataset so it never flies in.
      if (isAssets && visible) {
        getNavTrendChart().options.scales['y-assets'].display = true;
        getNavTrendChart().update('none');
      }
      chartRenderer.animateDatasetVisibility(getNavTrendChart(), datasetIndex, visible, {
        duration: visible ? 320 : 240,
        onComplete: () => {
          if (isAssets && !visible) {
            getNavTrendChart().options.scales['y-assets'].display = false;
            getNavTrendChart().update('none');
          }
        }
      });
      getRenderTrendStats()?.();
    };

    chkCompNav.addEventListener('change', updateCompVisibility);
    chkCompAssets.addEventListener('change', updateCompVisibility);
    chkCompSp500.addEventListener('change', updateCompVisibility);
    chkCompNdx.addEventListener('change', updateCompVisibility);
    chkCompCustom.addEventListener('change', updateCompVisibility);
    chkCompCustom2.addEventListener('change', updateCompVisibility);

    // 时间区间选择按钮绑定
    const timeSlicerGroup = document.getElementById('time-slicer-group');
    document.querySelectorAll('.time-slice-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        activateSegmentOption(timeSlicerGroup, e.currentTarget);
        setActiveTimeSlice(e.currentTarget.getAttribute('data-time-slice'));
        renderCharts();
      });
    });

    // 对数坐标切换功能已移除
  }

  window.FundChartControls = { init };
})();
