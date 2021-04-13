/*
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd
Copyright 2017, 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2018 - 2021 New Vector Ltd

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

// Squirrel on windows starts the app with various flags
// as hooks to tell us when we've been installed/uninstalled
// etc.
const checkSquirrelHooks = require('./squirrelhooks');
if (checkSquirrelHooks()) return;

const argv = require('minimist')(process.argv, {
    alias: {help: "h"},
});

const {
    app, ipcMain, powerSaveBlocker, BrowserWindow, Menu, autoUpdater, protocol, dialog, TouchBar, nativeImage,
} = require('electron');
const AutoLaunch = require('auto-launch');
const path = require('path');

const tray = require('./tray');
const vectorMenu = require('./vectormenu');
const webContentsHandler = require('./webcontents-handler');
const updater = require('./updater');
const {getProfileFromDeeplink, protocolInit, recordSSOSession} = require('./protocol');

const windowStateKeeper = require('electron-window-state');
const Store = require('electron-store');

const fs = require('fs');
const afs = fs.promises;
const request = require("request");

const crypto = require('crypto');
let keytar;
try {
    keytar = require('keytar');
} catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
        console.log("Keytar isn't installed; secure key storage is disabled.");
    } else {
        console.warn("Keytar unexpected error:", e);
    }
}

let seshatSupported = false;
let Seshat;
let SeshatRecovery;
let ReindexError;

const seshatDefaultPassphrase = "DEFAULT_PASSPHRASE";

try {
    const seshatModule = require('matrix-seshat');
    Seshat = seshatModule.Seshat;
    SeshatRecovery = seshatModule.SeshatRecovery;
    ReindexError = seshatModule.ReindexError;
    seshatSupported = true;
} catch (e) {
    if (e.code === "MODULE_NOT_FOUND") {
        console.log("Seshat isn't installed, event indexing is disabled.");
    } else {
        console.warn("Seshat unexpected error:", e);
    }
}

// Things we need throughout the file but need to be created
// async to are initialised in setupGlobals()
let asarPath;
let resPath;
let vectorConfig;
let iconPath;
let trayConfig;
let launcher;

if (argv["help"]) {
    console.log("Options:");
    console.log("  --profile-dir {path}: Path to where to store the profile.");
    console.log("  --profile {name}:     Name of alternate profile to use, allows for running multiple accounts.");
    console.log("  --devtools:           Install and use react-devtools and react-perf.");
    console.log("  --no-update:          Disable automatic updating.");
    console.log("  --hidden:             Start the application hidden in the system tray.");
    console.log("  --help:               Displays this help message.");
    console.log("And more such as --proxy, see:" +
        "https://electronjs.org/docs/api/command-line-switches");
    app.exit();
}

// Electron creates the user data directory (with just an empty 'Dictionaries' directory...)
// as soon as the app path is set, so pick a random path in it that must exist if it's a
// real user data directory.
function isRealUserDataDir(d) {
    return fs.existsSync(path.join(d, 'IndexedDB'));
}

// check if we are passed a profile in the SSO callback url
let userDataPath;

const userDataPathInProtocol = getProfileFromDeeplink(argv["_"]);
if (userDataPathInProtocol) {
    userDataPath = userDataPathInProtocol;
} else if (argv['profile-dir']) {
    userDataPath = argv['profile-dir'];
} else {
    let newUserDataPath = app.getPath('userData');
    if (argv['profile']) {
        newUserDataPath += '-' + argv['profile'];
    }
    const newUserDataPathExists = isRealUserDataDir(newUserDataPath);
    let oldUserDataPath = path.join(app.getPath('appData'), app.getName().replace('Element', 'Riot'));
    if (argv['profile']) {
        oldUserDataPath += '-' + argv['profile'];
    }

    const oldUserDataPathExists = isRealUserDataDir(oldUserDataPath);
    console.log(newUserDataPath + " exists: " + (newUserDataPathExists ? 'yes' : 'no'));
    console.log(oldUserDataPath + " exists: " + (oldUserDataPathExists ? 'yes' : 'no'));
    if (!newUserDataPathExists && oldUserDataPathExists) {
        console.log("Using legacy user data path: " + oldUserDataPath);
        userDataPath = oldUserDataPath;
    } else {
        userDataPath = newUserDataPath;
    }
}
app.setPath('userData', userDataPath);

async function tryPaths(name, root, rawPaths) {
    // Make everything relative to root
    const paths = rawPaths.map(p => path.join(root, p));

    for (const p of paths) {
        try {
            await afs.stat(p);
            return p + '/';
        } catch (e) {
        }
    }
    console.log(`Couldn't find ${name} files in any of: `);
    for (const p of paths) {
        console.log("\t"+path.resolve(p));
    }
    throw new Error(`Failed to find ${name} files`);
}

// Find the webapp resources and set up things that require them
async function setupGlobals() {
    // find the webapp asar.
    asarPath = await tryPaths("webapp", __dirname, [
        // If run from the source checkout, this will be in the directory above
        '../webapp.asar',
        // but if run from a packaged application, electron-main.js will be in
        // a different asar file so it will be two levels above
        '../../webapp.asar',
        // also try without the 'asar' suffix to allow symlinking in a directory
        '../webapp',
        // from a packaged application
        '../../webapp',
    ]);

    // we assume the resources path is in the same place as the asar
    resPath = await tryPaths("res", path.dirname(asarPath), [
        // If run from the source checkout
        'res',
        // if run from packaged application
        '',
    ]);

    try {
        vectorConfig = require(asarPath + 'config.json');
    } catch (e) {
        // it would be nice to check the error code here and bail if the config
        // is unparsable, but we get MODULE_NOT_FOUND in the case of a missing
        // file or invalid json, so node is just very unhelpful.
        // Continue with the defaults (ie. an empty config)
        vectorConfig = {};
    }

    try {
        // Load local config and use it to override values from the one baked with the build
        const localConfig = require(path.join(app.getPath('userData'), 'config.json'));

        // If the local config has a homeserver defined, don't use the homeserver from the build
        // config. This is to avoid a problem where Riot thinks there are multiple homeservers
        // defined, and panics as a result.
        const homeserverProps = ['default_is_url', 'default_hs_url', 'default_server_name', 'default_server_config'];
        if (Object.keys(localConfig).find(k => homeserverProps.includes(k))) {
            // Rip out all the homeserver options from the vector config
            vectorConfig = Object.keys(vectorConfig)
                .filter(k => !homeserverProps.includes(k))
                .reduce((obj, key) => {obj[key] = vectorConfig[key]; return obj;}, {});
        }

        vectorConfig = Object.assign(vectorConfig, localConfig);
    } catch (e) {
        // Could not load local config, this is expected in most cases.
    }

    // The tray icon
    // It's important to call `path.join` so we don't end up with the packaged asar in the final path.
    const iconFile = `element.${process.platform === 'win32' ? 'ico' : 'png'}`;
    iconPath = path.join(resPath, "img", iconFile);
    trayConfig = {
        icon_path: iconPath,
        brand: vectorConfig.brand || 'Element',
    };

    // launcher
    launcher = new AutoLaunch({
        name: vectorConfig.brand || 'Element',
        isHidden: true,
        mac: {
            useLaunchAgent: true,
        },
    });
}

async function moveAutoLauncher() {
    // Look for an auto-launcher under 'Riot' and if we find one, port it's
    // enabled/disbaledp-ness over to the new 'Element' launcher
    if (!vectorConfig.brand || vectorConfig.brand === 'Element') {
        const oldLauncher = new AutoLaunch({
            name: 'Riot',
            isHidden: true,
            mac: {
                useLaunchAgent: true,
            },
        });
        const wasEnabled = await oldLauncher.isEnabled();
        if (wasEnabled) {
            await oldLauncher.disable();
            await launcher.enable();
        }
    }
}

const eventStorePath = path.join(app.getPath('userData'), 'EventStore');
const store = new Store({ name: "electron-config" });

let eventIndex = null;

let mainWindow = null;
global.appQuitting = false;

const exitShortcuts = [
    (input, platform) => platform !== 'darwin' && input.alt && input.code === 'F4',
    (input, platform) => platform !== 'darwin' && input.control && input.code === 'KeyQ',
    (input, platform) => platform === 'darwin' && input.meta && input.code === 'KeyQ',
];

const warnBeforeExit = (event, input) => {
    const shouldWarnBeforeExit = store.get('warnBeforeExit', true);
    const exitShortcutPressed = exitShortcuts.some(shortcutFn => shortcutFn(input, process.platform));

    if (shouldWarnBeforeExit && exitShortcutPressed) {
        const shouldCancelCloseRequest = dialog.showMessageBoxSync(mainWindow, {
            type: "question",
            buttons: ["Cancel", "Close Element"],
            message: "Are you sure you want to quit?",
            defaultId: 1,
            cancelId: 0,
        }) === 0;

        if (shouldCancelCloseRequest) {
            event.preventDefault();
        }
    }
};

const deleteContents = async (p) => {
    for (const entry of await afs.readdir(p)) {
        const curPath = path.join(p, entry);
        await afs.unlink(curPath);
    }
};

async function randomArray(size) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(size, (err, buf) => {
            if (err) {
                reject(err);
            } else {
                resolve(buf.toString("base64").replace(/=+$/g, ''));
            }
        });
    });
}

// handle uncaught errors otherwise it displays
// stack traces in popup dialogs, which is terrible (which
// it will do any time the auto update poke fails, and there's
// no other way to catch this error).
// Assuming we generally run from the console when developing,
// this is far preferable.
process.on('uncaughtException', function(error) {
    console.log('Unhandled exception', error);
});

let focusHandlerAttached = false;
ipcMain.on('setBadgeCount', function(ev, count) {
    app.badgeCount = count;
    if (count === 0 && mainWindow) {
        mainWindow.flashFrame(false);
    }
});

ipcMain.on('loudNotification', function() {
    if (process.platform === 'win32' && mainWindow && !mainWindow.isFocused() && !focusHandlerAttached) {
        mainWindow.flashFrame(true);
        mainWindow.once('focus', () => {
            mainWindow.flashFrame(false);
            focusHandlerAttached = false;
        });
        focusHandlerAttached = true;
    }
});

let powerSaveBlockerId = null;
ipcMain.on('app_onAction', function(ev, payload) {
    switch (payload.action) {
        case 'call_state':
            if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
                if (payload.state === 'ended') {
                    powerSaveBlocker.stop(powerSaveBlockerId);
                    powerSaveBlockerId = null;
                }
            } else {
                if (powerSaveBlockerId === null && payload.state === 'connected') {
                    powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
                }
            }
            break;
    }
});

ipcMain.on('ipcCall', async function(ev, payload) {
    if (!mainWindow) return;

    const args = payload.args || [];
    let ret;

    switch (payload.name) {
        case 'getUpdateFeedUrl':
            ret = autoUpdater.getFeedURL();
            break;
        case 'getAutoLaunchEnabled':
            ret = await launcher.isEnabled();
            break;
        case 'setAutoLaunchEnabled':
            if (args[0]) {
                launcher.enable();
            } else {
                launcher.disable();
            }
            break;
        case 'shouldWarnBeforeExit':
            ret = store.get('warnBeforeExit', true);
            break;
        case 'setWarnBeforeExit':
            store.set('warnBeforeExit', args[0]);
            break;
        case 'getMinimizeToTrayEnabled':
            ret = tray.hasTray();
            break;
        case 'setMinimizeToTrayEnabled':
            if (args[0]) {
                // Create trayIcon icon
                tray.create(trayConfig);
            } else {
                tray.destroy();
            }
            store.set('minimizeToTray', args[0]);
            break;
        case 'getAutoHideMenuBarEnabled':
            ret = global.mainWindow.autoHideMenuBar;
            break;
        case 'setAutoHideMenuBarEnabled':
            store.set('autoHideMenuBar', args[0]);
            global.mainWindow.autoHideMenuBar = Boolean(args[0]);
            global.mainWindow.setMenuBarVisibility(!args[0]);
            break;
        case 'getAppVersion':
            ret = app.getVersion();
            break;
        case 'focusWindow':
            if (mainWindow.isMinimized()) {
                mainWindow.restore();
            } else if (!mainWindow.isVisible()) {
                mainWindow.show();
            } else {
                mainWindow.focus();
            }
            break;
        case 'getConfig':
            ret = vectorConfig;
            break;
        case 'navigateBack':
            if (mainWindow.webContents.canGoBack()) {
                mainWindow.webContents.goBack();
            }
            break;
        case 'navigateForward':
            if (mainWindow.webContents.canGoForward()) {
                mainWindow.webContents.goForward();
            }
            break;
        case 'setSpellCheckLanguages':
            if (args[0] && args[0].length > 0) {
                mainWindow.webContents.session.setSpellCheckerEnabled(true);
                store.set("spellCheckerEnabled", true);

                try {
                    mainWindow.webContents.session.setSpellCheckerLanguages(args[0]);
                } catch (er) {
                    console.log("There were problems setting the spellcheck languages", er);
                }
            } else {
                mainWindow.webContents.session.setSpellCheckerEnabled(false);
                store.set("spellCheckerEnabled", false);
            }
            break;
        case 'getSpellCheckLanguages':
            if (store.get("spellCheckerEnabled", true)) {
                ret = mainWindow.webContents.session.getSpellCheckerLanguages();
            } else {
                ret = [];
            }
            break;
        case 'getAvailableSpellCheckLanguages':
            ret = mainWindow.webContents.session.availableSpellCheckerLanguages;
            break;

        case 'startSSOFlow':
            recordSSOSession(args[0]);
            break;

        case 'getPickleKey':
            try {
                ret = await keytar.getPassword("element.io", `${args[0]}|${args[1]}`);
                // migrate from riot.im (remove once we think there will no longer be
                // logins from the time of riot.im)
                if (ret === null) {
                    ret = await keytar.getPassword("riot.im", `${args[0]}|${args[1]}`);
                }
            } catch (e) {
                // if an error is thrown (e.g. keytar can't connect to the keychain),
                // then return null, which means the default pickle key will be used
                ret = null;
            }
            break;

        case 'createPickleKey':
            try {
                const pickleKey = await randomArray(32);
                await keytar.setPassword("element.io", `${args[0]}|${args[1]}`, pickleKey);
                ret = pickleKey;
            } catch (e) {
                ret = null;
            }
            break;

        case 'destroyPickleKey':
            try {
                await keytar.deletePassword("element.io", `${args[0]}|${args[1]}`);
                // migrate from riot.im (remove once we think there will no longer be
                // logins from the time of riot.im)
                await keytar.deletePassword("riot.im", `${args[0]}|${args[1]}`);
            } catch (e) {}
            break;

        case "breadcrumbs": {
            const { TouchBarPopover, TouchBarButton } = TouchBar;

            const recentsBar = new TouchBar({
                items: args[0].map(r => {
                    const defaultColors = ['#0DBD8B', '#368bd6', '#ac3ba8'];
                    let total = 0;
                    for (let i = 0; i < r.roomId.length; ++i) {
                        total += r.roomId.charCodeAt(i);
                    }

                    const button = new TouchBarButton({
                        label: r.initial,
                        backgroundColor: defaultColors[total % defaultColors.length],
                        click: () => {
                            global.mainWindow.loadURL(`vector://vector/webapp/#/room/${r.roomId}`);
                        },
                    });
                    if (r.avatarUrl) {
                        request({
                            url: r.avatarUrl,
                            encoding: null,
                        }, (err, resp, buffer) => {
                            if (err) return;
                            button.icon = nativeImage.createFromBuffer(buffer);
                            button.label = null;
                            button.backgroundColor = null;
                        });
                    }
                    return button;
                }),
            });

            const touchBar = new TouchBar({
                items: [
                    new TouchBarPopover({
                        label: "Recents",
                        showCloseButton: true,
                        items: recentsBar,
                    }),
                ],
            });
            global.mainWindow.setTouchBar(touchBar);
            break;
        }

        default:
            mainWindow.webContents.send('ipcReply', {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    mainWindow.webContents.send('ipcReply', {
        id: payload.id,
        reply: ret,
    });
});

ipcMain.on('seshat', async function(ev, payload) {
    if (!mainWindow) return;

    const sendError = (id, e) => {
        const error = {
            message: e.message,
        };

        mainWindow.webContents.send('seshatReply', {
            id: id,
            error: error,
        });
    };

    const args = payload.args || [];
    let ret;

    switch (payload.name) {
        case 'supportsEventIndexing':
            ret = seshatSupported;
            break;

        case 'initEventIndex':
            if (eventIndex === null) {
                const userId = args[0];
                const deviceId = args[1];
                const passphraseKey = `seshat|${userId}|${deviceId}`;

                let changePassphrase = false;
                let passphrase = seshatDefaultPassphrase;

                if (keytar) {
                    try {
                        // Try to get a passphrase for seshat.
                        const storedPassphrase = await keytar.getPassword("element.io", passphraseKey);

                        // If no passphrase was found mark that we should change
                        // it, if one is found, use that one.
                        if (storedPassphrase === null) {
                            changePassphrase = true;
                        } else {
                            passphrase = storedPassphrase;
                        }
                    } catch (e) {
                        console.log("Error getting the event index passphrase out of the secret store", e);
                    }
                }

                const openSeshat = async () => {
                    try {
                        await afs.mkdir(eventStorePath, {recursive: true});
                        return new Seshat(eventStorePath, {passphrase});
                    } catch (e) {
                        if (e instanceof ReindexError) {
                            // If this is a reindex error, the index schema
                            // changed. Try to open the database in recovery mode,
                            // reindex the database and finally try to open the
                            // database again.
                            const recoveryIndex = new SeshatRecovery(eventStorePath, {
                                passphrase,
                            });

                            const userVersion = await recoveryIndex.getUserVersion();

                            // If our user version is 0 we'll delete the db
                            // anyways so reindexing it is a waste of time.
                            if (userVersion === 0) {
                                await recoveryIndex.shutdown();

                                try {
                                    await deleteContents(eventStorePath);
                                } catch (e) {
                                }
                            } else {
                                await recoveryIndex.reindex();
                            }

                            return new Seshat(eventStorePath, {passphrase});
                        } else {
                            throw (e);
                        }
                    }
                };

                try {
                    eventIndex = await openSeshat();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }

                if (changePassphrase) {
                    try {
                        // Generate a new random passphrase.
                        const newPassphrase = await randomArray(32);
                        await keytar.setPassword("element.io", passphraseKey, newPassphrase);

                        // Set the new passphrase, this will close the event
                        // index.
                        await eventIndex.changePassphrase(newPassphrase);

                        // Re-open the event index with the new passphrase.
                        eventIndex = new Seshat(eventStorePath, {newPassphrase});
                    } catch (e) {
                        sendError(payload.id, e);
                        return;
                    }
                }
            }
            break;

        case 'closeEventIndex':
            if (eventIndex !== null) {
                const index = eventIndex;
                eventIndex = null;

                try {
                    await index.shutdown();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'deleteEventIndex':
            {
                try {
                    await deleteContents(eventStorePath);
                } catch (e) {
                }
            }

            break;

        case 'isEventIndexEmpty':
            if (eventIndex === null) ret = true;
            else ret = await eventIndex.isEmpty();
            break;

        case 'isRoomIndexed':
            if (eventIndex === null) ret = false;
            else ret = await eventIndex.isRoomIndexed(args[0]);
            break;

        case 'addEventToIndex':
            try {
                eventIndex.addEvent(args[0], args[1]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'deleteEvent':
            try {
                ret = await eventIndex.deleteEvent(args[0]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'commitLiveEvents':
            try {
                ret = await eventIndex.commit();
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'searchEventIndex':
            try {
                ret = await eventIndex.search(args[0]);
            } catch (e) {
                sendError(payload.id, e);
                return;
            }
            break;

        case 'addHistoricEvents':
            if (eventIndex === null) ret = false;
            else {
                try {
                    ret = await eventIndex.addHistoricEvents(
                        args[0], args[1], args[2]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'getStats':
            if (eventIndex === null) ret = 0;
            else {
                try {
                    ret = await eventIndex.getStats();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'removeCrawlerCheckpoint':
            if (eventIndex === null) ret = false;
            else {
                try {
                    ret = await eventIndex.removeCrawlerCheckpoint(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'addCrawlerCheckpoint':
            if (eventIndex === null) ret = false;
            else {
                try {
                    ret = await eventIndex.addCrawlerCheckpoint(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'loadFileEvents':
            if (eventIndex === null) ret = [];
            else {
                try {
                    ret = await eventIndex.loadFileEvents(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'loadCheckpoints':
            if (eventIndex === null) ret = [];
            else {
                try {
                    ret = await eventIndex.loadCheckpoints();
                } catch (e) {
                    ret = [];
                }
            }
            break;

        case 'setUserVersion':
            if (eventIndex === null) break;
            else {
                try {
                    await eventIndex.setUserVersion(args[0]);
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        case 'getUserVersion':
            if (eventIndex === null) ret = 0;
            else {
                try {
                    ret = await eventIndex.getUserVersion();
                } catch (e) {
                    sendError(payload.id, e);
                    return;
                }
            }
            break;

        default:
            mainWindow.webContents.send('seshatReply', {
                id: payload.id,
                error: "Unknown IPC Call: " + payload.name,
            });
            return;
    }

    mainWindow.webContents.send('seshatReply', {
        id: payload.id,
        reply: ret,
    });
});

app.commandLine.appendSwitch('--enable-usermedia-screen-capturing');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    console.log('Other instance detected: exiting');
    app.exit();
}

// do this after we know we are the primary instance of the app
protocolInit();

// Register the scheme the app is served from as 'standard'
// which allows things like relative URLs and IndexedDB to
// work.
// Also mark it as secure (ie. accessing resources from this
// protocol and HTTPS won't trigger mixed content warnings).
protocol.registerSchemesAsPrivileged([{
    scheme: 'vector',
    privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
    },
}]);

// Turn the sandbox on for *all* windows we might generate. Doing this means we don't
// have to specify a `sandbox: true` to each BrowserWindow.
//
// This also fixes an issue with window.open where if we only specified the sandbox
// on the main window we'd run into cryptic "ipc_renderer be broke" errors. Turns out
// it's trying to jump the sandbox and make some calls into electron, which it can't
// do when half of it is sandboxed. By turning on the sandbox for everything, the new
// window (no matter how temporary it may be) is also sandboxed, allowing for a clean
// transition into the user's browser.
app.enableSandbox();

app.on('ready', async () => {
    try {
        await setupGlobals();
        await moveAutoLauncher();
    } catch (e) {
        console.log("App setup failed: exiting", e);
        process.exit(1);
        // process.exit doesn't cause node to stop running code immediately,
        // so return (we could let the exception propagate but then we end up
        // with node printing all sorts of stuff about unhandled exceptions
        // when we want the actual error to be as obvious as possible).
        return;
    }

    if (argv['devtools']) {
        try {
            const { default: installExt, REACT_DEVELOPER_TOOLS, REACT_PERF } = require('electron-devtools-installer');
            installExt(REACT_DEVELOPER_TOOLS)
                .then((name) => console.log(`Added Extension: ${name}`))
                .catch((err) => console.log('An error occurred: ', err));
            installExt(REACT_PERF)
                .then((name) => console.log(`Added Extension: ${name}`))
                .catch((err) => console.log('An error occurred: ', err));
        } catch (e) {
            console.log(e);
        }
    }

    protocol.registerFileProtocol('vector', (request, callback) => {
        if (request.method !== 'GET') {
            callback({error: -322}); // METHOD_NOT_SUPPORTED from chromium/src/net/base/net_error_list.h
            return null;
        }

        const parsedUrl = new URL(request.url);
        if (parsedUrl.protocol !== 'vector:') {
            callback({error: -302}); // UNKNOWN_URL_SCHEME
            return;
        }
        if (parsedUrl.host !== 'vector') {
            callback({error: -105}); // NAME_NOT_RESOLVED
            return;
        }

        const target = parsedUrl.pathname.split('/');

        // path starts with a '/'
        if (target[0] !== '') {
            callback({error: -6}); // FILE_NOT_FOUND
            return;
        }

        if (target[target.length - 1] == '') {
            target[target.length - 1] = 'index.html';
        }

        let baseDir;
        if (target[1] === 'webapp') {
            baseDir = asarPath;
        } else {
            callback({error: -6}); // FILE_NOT_FOUND
            return;
        }

        // Normalise the base dir and the target path separately, then make sure
        // the target path isn't trying to back out beyond its root
        baseDir = path.normalize(baseDir);

        const relTarget = path.normalize(path.join(...target.slice(2)));
        if (relTarget.startsWith('..')) {
            callback({error: -6}); // FILE_NOT_FOUND
            return;
        }
        const absTarget = path.join(baseDir, relTarget);

        callback({
            path: absTarget,
        });
    });

    if (argv['no-update']) {
        console.log('Auto update disabled via command line flag "--no-update"');
    } else if (vectorConfig['update_base_url']) {
        console.log(`Starting auto update with base URL: ${vectorConfig['update_base_url']}`);
        updater.start(vectorConfig['update_base_url']);
    } else {
        console.log('No update_base_url is defined: auto update is disabled');
    }

    // Load the previous window state with fallback to defaults
    const mainWindowState = windowStateKeeper({
        defaultWidth: 1024,
        defaultHeight: 768,
    });

    const preloadScript = path.normalize(`${__dirname}/preload.js`);
    mainWindow = global.mainWindow = new BrowserWindow({
        // https://www.electronjs.org/docs/faq#the-font-looks-blurry-what-is-this-and-what-can-i-do
        backgroundColor: '#fff',

        icon: iconPath,
        show: false,
        autoHideMenuBar: store.get('autoHideMenuBar', true),

        x: mainWindowState.x,
        y: mainWindowState.y,
        width: mainWindowState.width,
        height: mainWindowState.height,
        webPreferences: {
            preload: preloadScript,
            nodeIntegration: false,
            //sandbox: true, // We enable sandboxing from app.enableSandbox() above
            enableRemoteModule: false,
            contextIsolation: true,
            webgl: false,
        },
    });
    mainWindow.loadURL('vector://vector/webapp/');
    Menu.setApplicationMenu(vectorMenu);

    // Handle spellchecker
    // For some reason spellCheckerEnabled isn't persisted so we have to use the store here
    mainWindow.webContents.session.setSpellCheckerEnabled(store.get("spellCheckerEnabled", true));

    // Create trayIcon icon
    if (store.get('minimizeToTray', true)) tray.create(trayConfig);

    mainWindow.once('ready-to-show', () => {
        mainWindowState.manage(mainWindow);

        if (!argv['hidden']) {
            mainWindow.show();
        } else {
            // hide here explicitly because window manage above sometimes shows it
            mainWindow.hide();
        }
    });

    mainWindow.webContents.on('before-input-event', warnBeforeExit);

    mainWindow.on('closed', () => {
        mainWindow = global.mainWindow = null;
    });
    mainWindow.on('close', async (e) => {
        // If we are not quitting and have a tray icon then minimize to tray
        if (!global.appQuitting && (tray.hasTray() || process.platform === 'darwin')) {
            // On Mac, closing the window just hides it
            // (this is generally how single-window Mac apps
            // behave, eg. Mail.app)
            e.preventDefault();
            mainWindow.hide();
            return false;
        }
    });

    if (process.platform === 'win32') {
        // Handle forward/backward mouse buttons in Windows
        mainWindow.on('app-command', (e, cmd) => {
            if (cmd === 'browser-backward' && mainWindow.webContents.canGoBack()) {
                mainWindow.webContents.goBack();
            } else if (cmd === 'browser-forward' && mainWindow.webContents.canGoForward()) {
                mainWindow.webContents.goForward();
            }
        });
    }

    webContentsHandler(mainWindow.webContents);
});

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    mainWindow.show();
});

function beforeQuit() {
    global.appQuitting = true;
    if (mainWindow) {
        mainWindow.webContents.send('before-quit');
    }
}

app.on('before-quit', beforeQuit);
app.on('before-quit-for-update', beforeQuit);

app.on('second-instance', (ev, commandLine, workingDirectory) => {
    // If other instance launched with --hidden then skip showing window
    if (commandLine.includes('--hidden')) return;

    // Someone tried to run a second instance, we should focus our window.
    if (mainWindow) {
        if (!mainWindow.isVisible()) mainWindow.show();
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
    }
});

// Set the App User Model ID to match what the squirrel
// installer uses for the shortcut icon.
// This makes notifications work on windows 8.1 (and is
// a noop on other platforms).
app.setAppUserModelId('com.squirrel.element-desktop.Element');
