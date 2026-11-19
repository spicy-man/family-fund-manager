(function () {
  function isDarkTheme(theme) {
    if (theme === 'dark') return true;
    if (theme === 'light') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function getSeriesColors() {
    const styles = getComputedStyle(document.body);
    return Object.fromEntries(['assets', 'nav', 'sp500', 'ndx', 'custom', 'custom2']
      .map(name => [name, styles.getPropertyValue(`--series-${name}`).trim()]));
  }

  function hexToRgba(color, alpha) {
    const hex = color.replace('#', '');
    const value = Number.parseInt(hex.length === 3 ? hex.split('').map(char => char + char).join('') : hex, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }

  function getAvatarText(name) {
    if (!name) return '';
    if (name.length <= 2) return name;
    const isChinese = /^[\u4e00-\u9fa5]+$/.test(name);
    if (isChinese) {
      return name.substring(name.length - 2);
    }
    return name.substring(0, 2).toUpperCase();
  }

  // 成员列表前八位使用不同的柔和颜色，避免头像颜色碰撞；超出后再稳定循环。
  function getMemberAvatarColor(memberKey, isDark, memberIndex) {
    const lightPalette = [
      ['#E8EEF7', '#344054'], ['#F9EDD8', '#5B4630'],
      ['#ECEFF1', '#3F4A54'], ['#E5F2EA', '#315D43'],
      ['#F6E7ED', '#704052'], ['#ECE8F8', '#4D4272'],
      ['#E2F1F4', '#285B63'], ['#F4EBDD', '#67512F']
    ];
    const darkPalette = [
      ['#31445B', '#DCEBFF'], ['#5C4930', '#FFE8BF'],
      ['#424A52', '#E5EBF0'], ['#315541', '#D5F2DF'],
      ['#5C3C4B', '#FFDCE8'], ['#494160', '#E8DEFF'],
      ['#30565B', '#D2F4F6'], ['#5A4C35', '#FBE8C4']
    ];
    const key = String(memberKey || 'member');
    const hash = Array.from(key).reduce((value, char) => ((value * 31) + char.charCodeAt(0)) >>> 0, 0);
    const palette = isDark ? darkPalette : lightPalette;
    const colorIndex = Number.isInteger(memberIndex) ? memberIndex : hash;
    const [background, color] = palette[colorIndex % palette.length];
    return { background, color };
  }

  function escapeHtml(str) {
    if (str === undefined || str === null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(amount) {
    if (amount === undefined || amount === null) return '0.00';
    return Number(amount).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  function formatRatePercent(value, fallback = '') {
    const rate = Number(value);
    if (!Number.isFinite(rate)) return fallback;
    return `${(rate * 100).toFixed(2).replace(/\.00$/, '')}%`;
  }

  function createChartGradient(ctx, colorStart, colorEnd) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 250);
    gradient.addColorStop(0, colorStart);
    gradient.addColorStop(1, colorEnd);
    return gradient;
  }

  window.FundUiUtils = {
    isDarkTheme,
    getSeriesColors,
    hexToRgba,
    getAvatarText,
    getMemberAvatarColor,
    escapeHtml,
    formatMoney,
    formatRatePercent,
    createChartGradient
  };
})();
