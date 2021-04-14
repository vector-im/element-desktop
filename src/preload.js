/*
Copyright 2018, 2019, 2021 New Vector Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const { ipcRenderer, desktopCapturer, contextBridge } = require('electron');

// Expose only expected IPC wrapper APIs to the renderer process to avoid
// handing out generalised messaging access.

const CHANNELS = [
    "app_onAction",
    "before-quit",
    "check_updates",
    "install_update",
    "ipcCall",
    "ipcReply",
    "loudNotification",
    "preferences",
    "seshat",
    "seshatReply",
    "setBadgeCount",
    "update-downloaded",
    "userDownload",
];

contextBridge.exposeInMainWorld(
    "electron",
    {
        on(channel, listener) {
            if (!CHANNELS.includes(channel)) {
                console.error(`Unknown IPC channel ${channel} ignored`);
                return;
            }
            ipcRenderer.on(channel, listener);
        },
        removeListener(channel, listener) {
            if (!CHANNELS.includes(channel)) {
                console.error(`Unknown IPC channel ${channel} ignored`);
                return;
            }
            ipcRenderer.removeListener(channel, listener);
        },
        send(channel, ...args) {
            if (!CHANNELS.includes(channel)) {
                console.error(`Unknown IPC channel ${channel} ignored`);
                return;
            }
            ipcRenderer.send(channel, ...args);
        },
        async getDesktopCapturerSources(options) {
            const sources = await desktopCapturer.getSources(options);
            const desktopCapturerSources = [];

            for (const source of sources) {
                desktopCapturerSources.push({
                    id: source.id,
                    name: source.name,
                    thumbnailURL: source.thumbnail.toDataURL(),
                });
            }

            return desktopCapturerSources;
        },
    },
);
