/**
 * Custom Chart.js plugins shared by `chart-renderer.js`:
 * - operationTrackPlugin: interactive deposit/withdraw/transfer/settlement markers along the X axis
 * - allocationLabelsPlugin: responsive legend placement and non-overlapping callout labels for the member doughnut
 * - datasetOpacityPlugin: smooth fade transitions when toggling trend series visibility
 */
window.FundChartPlugins = {
  operationTypes: {
    deposit: { symbol: '↑', label: '入金', color: '#23845a' },
    withdraw: { symbol: '↓', label: '出金', color: '#c45b60' },
    transfer: { symbol: '⇄', label: '内部转让', color: '#62738b' },
    performance_settlement: { symbol: '◆', label: '业绩结算', color: '#a67b36' }
  },

  groupOperations(history, events = []) {
    const byId = new Map(events.map(event => [event.id, event]));
    const days = new Map();
    history.forEach((point, index) => {
      // Match the operation point on the curve, not a later same-day valuation.
      if (!this.operationTypes[point.type]) return;
      let day = days.get(point.date);
      if (!day) {
        day = { date: point.date, index, events: [] };
        days.set(point.date, day);
      }
      day.index = index;
      day.events.push(byId.get(point.eventId) || point);
    });
    return [...days.values()];
  },

  clusterOperations(days, scale, gap = 30) {
    const clusters = [];
    days.forEach(day => {
      const x = scale.getPixelForValue(day.index);
      const last = clusters.at(-1);
      if (last && x - last.firstX < gap) {
        last.days.push(day);
        last.lastX = x;
        // Anchor merged markers to the first date so neighbouring groups stay separated.
      } else {
        clusters.push({ x, firstX: x, lastX: x, days: [day] });
      }
    });
    return clusters;
  },

  operationTrackPlugin: {
    id: 'operationTrack',
    afterDestroy(chart) {
      clearTimeout(chart.$operationHideTimer);
      const container = chart.canvas?.parentElement;
      container?.querySelector('.chart-operation-track')?.remove();
      container?.querySelector('.chart-operation-tooltip')?.remove();
    },
    afterDraw(chart) {
      const model = chart.$operationTrack;
      const container = chart.canvas.parentElement;
      if (!model || !container || !chart.chartArea || !chart.scales.x) return;
      let track = container.querySelector('.chart-operation-track');
      if (!track) {
        track = document.createElement('div');
        track.className = 'chart-operation-track';
        track.setAttribute('role', 'group');
        track.setAttribute('aria-label', '图表操作轨道');
        container.appendChild(track);
      }
      const clusters = window.FundChartPlugins.clusterOperations(model.days, chart.scales.x);
      const y = chart.chartArea.bottom + 12;
      const key = JSON.stringify([model.version, chart.width, y, clusters.map(group => group.x)]);
      if (track.dataset.layout !== key) {
        track.dataset.layout = key;
        track.replaceChildren();
        chart.$activeOperation = null;
        track.style.top = `${y}px`;
        track.style.left = `${chart.chartArea.left}px`;
        track.style.width = `${chart.chartArea.right - chart.chartArea.left}px`;
        clusters.forEach(group => {
          const events = group.days.flatMap(day => day.events);
          const type = window.FundChartPlugins.operationTypes[events[0].type];
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'chart-operation-marker';
          button.style.left = `${group.x - chart.chartArea.left}px`;
          button.style.setProperty('--operation-color', events.length > 1 ? '#858b95' : type.color);
          button.textContent = events.length > 1 ? String(events.length) : type.symbol;
          const dates = group.days.map(day => day.date);
          button.setAttribute('aria-label', `${dates.join('、')}，${events.length} 笔操作：${[...new Set(events.map(event => window.FundChartPlugins.operationTypes[event.type].label))].join('、')}`);
          const show = () => {
            clearTimeout(chart.$operationHideTimer);
            chart.$activeOperation = group;
            const existing = container.querySelector('.chart-external-tooltip');
            if (existing) existing.style.opacity = '0';
            let tooltip = container.querySelector('.chart-operation-tooltip');
            if (!tooltip) {
              tooltip = document.createElement('div');
              tooltip.className = 'glass-tooltip chart-operation-tooltip';
              tooltip.setAttribute('role', 'tooltip');
              tooltip.addEventListener('mouseenter', () => clearTimeout(chart.$operationHideTimer));
              tooltip.addEventListener('mouseleave', () => {
                if (chart.$pinnedOperation) return;
                chart.$activeOperation = null; tooltip.hidden = true;
                chart.$operationTrack.renderStats(); chart.draw();
              });
              container.appendChild(tooltip);
            }
            tooltip.replaceChildren();
            group.days.forEach(day => {
              const title = document.createElement('div');
              title.className = 'chart-external-tooltip-title';
              title.textContent = `${day.date} · ${day.events.length} 笔操作`;
              tooltip.appendChild(title);
              day.events.forEach(event => {
                const row = document.createElement('div');
                row.className = 'chart-operation-detail privacy-sensitive';
                row.textContent = chart.$operationTrack.describe(event);
                tooltip.appendChild(row);
              });
            });
            tooltip.hidden = false;
            const position = window.FundChartRenderer.calculateTooltipPosition({
              caretX: group.x, caretY: y,
              tooltipWidth: tooltip.offsetWidth, tooltipHeight: tooltip.offsetHeight,
              containerWidth: container.clientWidth, containerHeight: container.clientHeight, inset: 12
            });
            tooltip.style.left = `${position.left}px`;
            // Keep the entire card above the marker, even beyond the chart bounds.
            tooltip.style.top = `${y - tooltip.offsetHeight - 16}px`;
            chart.$operationTrack.renderStats(group.days.at(-1).index);
            chart.draw();
          };
          const hide = () => {
            if (chart.$pinnedOperation === group) return;
            chart.$activeOperation = null;
            const tooltip = container.querySelector('.chart-operation-tooltip');
            if (tooltip) tooltip.hidden = true;
            chart.$operationTrack.renderStats();
            chart.draw();
          };
          button.addEventListener('mouseenter', show);
          button.addEventListener('mouseleave', () => { chart.$operationHideTimer = setTimeout(hide, 150); });
          button.addEventListener('focus', show);
          button.addEventListener('blur', () => { chart.$pinnedOperation = null; hide(); });
          button.addEventListener('click', () => {
            if (chart.$pinnedOperation === group) { chart.$pinnedOperation = null; hide(); }
            else { chart.$pinnedOperation = group; show(); }
          });
          button.addEventListener('keydown', event => {
            if (event.key === 'Escape') { chart.$pinnedOperation = null; hide(); }
          });
          track.appendChild(button);
        });
        chart.$pinnedOperation = null;
        const tooltip = container.querySelector('.chart-operation-tooltip');
        if (tooltip) tooltip.hidden = true;
      }
      const toggle = document.getElementById('chk-chart-operations');
      track.hidden = toggle ? !toggle.checked : false;
      if (track.hidden) {
        chart.$activeOperation = null;
        chart.$pinnedOperation = null;
        const tooltip = container.querySelector('.chart-operation-tooltip');
        if (tooltip) tooltip.hidden = true;
      }
      if (chart.$activeOperation) {
        const { ctx, chartArea } = chart;
        ctx.save();
        ctx.strokeStyle = chart.$operationTrack.dark ? 'rgba(203,213,225,.55)' : 'rgba(98,115,139,.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        chart.$activeOperation.days.forEach(day => {
          const x = chart.scales.x.getPixelForValue(day.index);
          ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
        });
        ctx.restore();
      }
    }
  },

  allocationLabelsPlugin: {
    id: 'allocationLabels',
    beforeLayout(chart) {
      // Keep the legend out of the leader labels' way on narrow panels.
      const position = chart.width < 560 ? 'bottom' : 'right';
      chart.options.plugins.legend.position = position;
      if (chart.legend) {
        // Chart.js caches the legend's options separately during beforeUpdate.
        // Keep its orientation and layout box in sync on the first resize.
        chart.legend.options.position = position;
        chart.legend.position = position;
      }
    },
    afterDatasetsDraw(chart, _args, options) {
      if (options.empty) return;
      const values = chart.data.datasets[0].data;
      const total = values.reduce((sum, value) => sum + Number(value), 0);
      if (!(total > 0)) return;
      const { ctx, chartArea } = chart;
      const sides = [[], []];
      chart.getDatasetMeta(0).data.forEach((arc, index) => {
        if (!(values[index] > 0) || !chart.getDataVisibility(index)) return;
        const { x, y, startAngle, endAngle, outerRadius } = arc.getProps(
          ['x', 'y', 'startAngle', 'endAngle', 'outerRadius'], true
        );
        if (!(outerRadius > 0)) return;
        const angle = (startAngle + endAngle) / 2;
        const direction = Math.cos(angle) >= 0 ? 1 : -1;
        sides[direction === 1 ? 1 : 0].push({
          x: x + Math.cos(angle) * outerRadius,
          y: y + Math.sin(angle) * outerRadius,
          elbowX: x + direction * (outerRadius + 12),
          labelY: y + Math.sin(angle) * (outerRadius + 14),
          direction,
          text: `${(values[index] / total * 100).toFixed(2)}%`
        });
      });
      ctx.save();
      ctx.font = '600 12px Inter, sans-serif';
      ctx.fillStyle = chart.options.plugins.legend.labels.color;
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1;
      ctx.textBaseline = 'middle';
      const top = chartArea.top + 6;
      const bottom = chartArea.bottom - 6;
      sides.forEach(labels => {
        labels.sort((a, b) => a.labelY - b.labelY);
        const gap = Math.min(20, (bottom - top) / Math.max(1, labels.length - 1));
        // Separate nearby small slices, then pull the group back inside the canvas.
        labels.forEach((label, index) => {
          label.labelY = Math.max(top, label.labelY, index ? labels[index - 1].labelY + gap : top);
        });
        for (let index = labels.length - 1; index >= 0; index--) {
          labels[index].labelY = Math.min(labels[index].labelY,
            index === labels.length - 1 ? bottom : labels[index + 1].labelY - gap);
        }
        labels.forEach(label => {
          const textWidth = ctx.measureText(label.text).width;
          const rightEdge = chart.legend?.position === 'right' ? chart.legend.left - 8 : chart.width - 8;
          const endX = label.direction === 1
            ? Math.min(label.elbowX + 14, rightEdge - textWidth - 4)
            : Math.max(label.elbowX - 14, textWidth + 12);
          ctx.beginPath();
          ctx.moveTo(label.x, label.y);
          ctx.lineTo(label.elbowX, label.labelY);
          ctx.lineTo(endX, label.labelY);
          ctx.stroke();
          ctx.textAlign = label.direction === 1 ? 'left' : 'right';
          ctx.fillText(label.text, endX + label.direction * 4, label.labelY);
        });
      });
      ctx.restore();
    }
  },

  datasetOpacityPlugin: {
    id: 'trendDatasetOpacity',
    beforeDatasetDraw(chart, args) {
      const opacity = chart.data.datasets[args.index]?.$visibilityOpacity;
      if (!Number.isFinite(opacity)) return;
      chart.ctx.save();
      chart.ctx.globalAlpha *= opacity;
    },
    afterDatasetDraw(chart, args) {
      const opacity = chart.data.datasets[args.index]?.$visibilityOpacity;
      if (Number.isFinite(opacity)) chart.ctx.restore();
    }
  }
};
