(function () {
  "use strict";

  const btnOpenRecorder = document.getElementById("btnOpenRecorder");

  btnOpenRecorder.addEventListener("click", () => {
    const url = chrome.runtime.getURL("recorder.html");
    chrome.windows.create({
      url,
      type: "popup",
      width: 520,
      height: 820,
    });
    window.close();
  });
})();
