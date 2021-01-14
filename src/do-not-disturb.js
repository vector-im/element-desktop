// Always false if the platform doesn't support it.
const LINUX_SETTING_COMMAND = "gsettings get org.gnome.desktop.notifications show-banners";

const { promisify } = require('util');
const childProcess = require('child_process');
const exec = promisify(childProcess.exec);

let doNotDisturbMode = false;

function init() {
    if (process.platform === "linux") {
        return initForLinux();
    }
}

function isDoNotDisturb() {
    return doNotDisturbMode;
}

async function initForLinux() {
    const DBus = require('dbus-next');
    // This is specific to the GNOME implementation for do-not-distrub

    // First we need to determine the value of dnd.
    try {
        // XXX: After much flailing about, I couldn't find another acceptable way to fetch this setting value.
        const value = (await exec(LINUX_SETTING_COMMAND, { encoding: "utf-8" })).trim();
        if (value) {
            // Anything other than true will be safely false.
            // Invert because show-banners === do-disturb :)
            doNotDisturbMode = value !== 'true';
            console.log(`do-not-disturb value has been detected as: ${doNotDisturbMode}`);
        }
    } catch (ex) {
        console.warn("Could not execute gsettings command to determine do-not-disturb value. Functionality disabled");
        console.debug(ex.message);
        return;
    }


    const session = DBus.sessionBus();
    process.on("exit", () => session.disconnect());
    const obj = await session.getProxyObject('ca.desrt.dconf', '/ca/desrt/dconf/Writer/user');
    const signaller = obj.getInterface('ca.desrt.dconf.Writer');
    signaller.on('Notify', (settingName) => {
        if (settingName == '/org/gnome/desktop/notifications/show-banners') {
            // The D-BUS signal will only tell you that the setting changed, but annoyingly
            // not the value. Since we got the value on startup, assume it's just been toggled.
            doNotDisturbMode = !doNotDisturbMode;
            console.log(`do-not-disturb value has been detected as: ${global.isDoNotDisturb}`);
        }
    });
}

module.exports = {
    init,
    isDoNotDisturb,
};
