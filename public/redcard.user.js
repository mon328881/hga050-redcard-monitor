// ==UserScript==
// @name         hga050 滚球红牌监控
// @namespace    hga-redcard
// @version      1.0.1
// @description  滚球红牌提醒：弹窗+滴滴声+定位
// @match        *://hga050.com/*
// @match        *://*.hga050.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://REPLACE_DOMAIN/redcard.user.js
// @updateURL    https://REPLACE_DOMAIN/redcard.user.js
// ==/UserScript==

(function () {
  "use strict";
  // 部署后把域名写死；安装页也会提示。书签方案不依赖此文件。
  var SCRIPT_URL = "https://REPLACE_DOMAIN/redcard-monitor.js";

  function boot() {
    if (window.__HGA_REDCARD_MONITOR__ || /REPLACE_DOMAIN/.test(SCRIPT_URL)) return;
    var s = document.createElement("script");
    s.src = SCRIPT_URL + "?t=" + Date.now();
    s.charset = "utf-8";
    document.documentElement.appendChild(s);
  }

  setTimeout(boot, 2000);
})();
