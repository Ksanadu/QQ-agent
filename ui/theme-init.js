/* 主题预置：在样式生效前就定好 data-theme，避免首屏闪白/闪黑。
       只认 dark / light，非法值回退暗色。
       这里只做"应用"，真正的切换逻辑与持久化在前端脚本。 */
    (function () {
      try {
        var saved = localStorage.getItem('qqa-theme') || '';
        var theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';
        document.documentElement.setAttribute('data-theme', theme);
      } catch (e) {
        document.documentElement.setAttribute('data-theme', 'dark');
      }
    })();
