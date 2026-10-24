const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("factoryDesktop", Object.freeze({ channelPopups: true }));
