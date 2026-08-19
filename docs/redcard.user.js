// ==UserScript==
// @name         hga050-redcard
// @namespace    hga-redcard
// @version      1.2.0
// @description  live football red card alert
// @include      *://hga050.com/*
// @include      *://*.hga050.com/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  "use strict";
  var SCRIPT_URL = "https://mon328881.github.io/hga050-redcard-monitor/redcard-monitor.js";

  function boot() {
    if (window.__HGA_REDCARD_MONITOR__) return;
    var s = document.createElement("script");
    s.src = SCRIPT_URL + "?t=" + Date.now();
    s.charset = "utf-8";
    (document.head || document.documentElement).appendChild(s);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      setTimeout(boot, 1500);
    });
  } else {
    setTimeout(boot, 1500);
  }
})();
