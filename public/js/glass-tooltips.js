(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    if (!window.Hyalite) return;
    const engine = window.Hyalite;
    const storageKey = 'fund-tooltip-glass-v1';
    const initial = { ...engine.DEFAULTS, thickness: 220, blur: 12, shade: 0, rim: 0, edge: 0.1, sat: 3, materialize: 160 };
    const controls = [
      ['thickness', '厚度', 0, 400, 1, 'px'],
      ['blur', '模糊', 0, 64, 0.5, 'px'],
      ['shade', '边缘暗度', 0, 2, 0.01, ''],
      ['bevel', '折射宽度', 1, 400, 1, 'px'],
      ['slope', '折射斜率', 0.2, 4, 0.05, ''],
      ['dispersion', '色散', 0, 8, 0.1, 'px'],
      ['rim', '边缘高光', 0, 4, 0.01, ''],
      ['edgeW', '高光宽度', 0.5, 64, 0.5, 'px'],
      ['edge', '轮廓亮度', 0, 2, 0.01, ''],
      ['sat', '边缘饱和度', 0, 3, 0.01, ''],
      ['light', '光照方向', -180, 180, 1, '°'],
      ['smooth', '边缘平滑', 0, 4, 0.1, 'px']
    ];
    let options = { ...initial };
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && typeof saved === 'object') {
        controls.forEach(([key, , min, max]) => {
          if (typeof saved[key] === 'number' && Number.isFinite(saved[key])) {
            options[key] = Math.max(min, Math.min(max, saved[key]));
          }
        });
        if (['circle', 'squircle', 'lip'].includes(saved.shape)) options.shape = saved.shape;
        // Apply the requested preset once, preserving all other saved controls.
        if (!(saved.presetRevision >= 1)) {
          options.shade = initial.shade;
          options.rim = initial.rim;
          options.edge = initial.edge;
        }
        if (!(saved.presetRevision >= 2)) options.sat = initial.sat;
      }
    } catch (_) { /* Storage is optional. */ }

    const save = () => {
      try { localStorage.setItem(storageKey, JSON.stringify({ ...options, presetRevision: 2 })); } catch (_) { /* Optional. */ }
    };
    save();

    // Never use setOpts: it would also retune the workflow buttons.
    let watcher = engine.watch(document.body, '.glass-tooltip', options);
    let timer;
    const apply = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        watcher.stop();
        watcher = engine.watch(document.body, '.glass-tooltip', { ...options, materialize: 0 });
        document.documentElement.style.setProperty('--tooltip-glass-blur', `${options.blur}px`);
        save();
      }, 80);
    };
    document.documentElement.style.setProperty('--tooltip-glass-blur', `${options.blur}px`);

    const panel = document.createElement('details');
    panel.className = 'glass-tuning-panel';
    const summary = document.createElement('summary');
    summary.textContent = '玻璃调参';
    panel.appendChild(summary);
    const body = document.createElement('div');
    body.className = 'glass-tuning-body';
    const hint = document.createElement('p');
    hint.textContent = '拖动即生效 · 自动记住参数 · 仅调整 tooltip';
    body.appendChild(hint);
    const preview = document.createElement('div');
    preview.className = 'glass-tuning-preview';
    const sample = document.createElement('div');
    sample.className = 'glass-tooltip glass-tuning-sample';
    const title = document.createElement('strong');
    title.textContent = '实时玻璃预览';
    const value = document.createElement('span');
    value.textContent = '净值 1.2345 · +12.34%';
    sample.append(title, value);
    preview.appendChild(sample);
    body.appendChild(preview);
    const inputs = new Map();
    controls.forEach(([key, name, min, max, step, unit]) => {
      const row = document.createElement('label');
      row.className = 'glass-tuning-row';
      const text = document.createElement('span');
      text.textContent = `${name} · ${key}`;
      const output = document.createElement('output');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = min;
      input.max = max;
      input.step = step;
      input.value = options[key];
      input.setAttribute('aria-label', `${name} ${key}`);
      const sync = () => {
        input.value = options[key];
        output.value = `${options[key]}${unit}`;
        input.setAttribute('aria-valuetext', output.value);
      };
      sync();
      inputs.set(key, sync);
      input.addEventListener('input', () => { options[key] = Number(input.value); sync(); apply(); });
      row.append(text, output, input);
      body.appendChild(row);
    });
    const shapeLabel = document.createElement('label');
    shapeLabel.className = 'glass-tuning-shape';
    shapeLabel.textContent = '边缘形状 · shape';
    const shape = document.createElement('select');
    [['squircle', '柔和方圆'], ['circle', '圆弧'], ['lip', '凸起边缘']].forEach(([key, name]) => {
      const option = document.createElement('option');
      option.value = key;
      option.textContent = name;
      shape.appendChild(option);
    });
    shape.value = options.shape;
    shape.addEventListener('change', () => { options.shape = shape.value; apply(); });
    shapeLabel.appendChild(shape);
    body.appendChild(shapeLabel);
    const actions = document.createElement('div');
    actions.className = 'glass-tuning-actions';
    [['恢复初始参数', initial], ['官方默认', engine.DEFAULTS]].forEach(([text, defaults]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.addEventListener('click', () => {
        options = { ...defaults };
        inputs.forEach(sync => sync());
        shape.value = options.shape;
        apply();
      });
      actions.appendChild(button);
    });
    body.appendChild(actions);
    if (!engine.supported()) {
      hint.textContent = '当前浏览器仅支持模糊；Chrome / Edge 可预览完整折射。';
    }
    panel.appendChild(body);
    document.body.appendChild(panel);
  });
})();
