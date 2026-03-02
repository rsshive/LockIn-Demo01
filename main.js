const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const { exec } = require('child_process');

let win;
let whitelistedApp = null;
let whitelistInterval = null;
let selectedAppsArray = [];
let isRecovering = false;

function focusExternalApp(appName) {
    if (!appName) return;
    whitelistedApp = appName;
    console.log("Focusing External:", appName);

    // We only process the selected apps + LockIn itself
    const allAppsList = (selectedAppsArray && selectedAppsArray.length > 0) ? selectedAppsArray : [appName];
    const joinedApps = allAppsList.join(',');

    const psScript = `
        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
            [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
            [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
            [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        }
"@
        $HWND_TOPMOST = New-Object IntPtr(-1)
        $HWND_NOTOPMOST = New-Object IntPtr(-2)
        $SWP_NOMOVE = 0x0002
        $SWP_NOSIZE = 0x0001
        
        # Demote all selected apps that aren't the target
        $allApps = "${joinedApps}" -split ","
        foreach ($name in $allApps) {
            if ($name -eq "${appName}") { continue }
            $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
            if ($p) {
                foreach ($proc in $p) {
                    [Win32]::SetWindowPos($proc.MainWindowHandle, $HWND_NOTOPMOST, 0,0,0,0, 3)
                }
            }
        }
        
        # Promote and focus target app
        $target = Get-Process -Name "${appName}" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($target) {
            [Win32]::ShowWindow($target.MainWindowHandle, 9)
            [Win32]::SetWindowPos($target.MainWindowHandle, $HWND_TOPMOST, 0,0,0,0, 3)
            [Win32]::SetForegroundWindow($target.MainWindowHandle)
        }
    `;
    const base64Cmd = Buffer.from(psScript, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -EncodedCommand ${base64Cmd}`);
}

function checkActiveWindow() {
    if (!win || !win.isKiosk() || isRecovering) return;

    const psScript = `
        Add-Type -TypeDefinition @"
        using System;
        using System.Runtime.InteropServices;
        public class Win32 {
            [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
            [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
        }
"@
        $hwnd = [Win32]::GetForegroundWindow()
        $pid = 0
        $null = [Win32]::GetWindowThreadProcessId($hwnd, [ref]$pid)
        try { (Get-Process -Id $pid).Name } catch { "Unknown" }
    `;

    exec(`powershell -NoProfile -Command "${psScript.replace(/\n/g, ' ')}"`, (error, stdout) => {
        if (!error && stdout && !isRecovering) {
            const activeAppName = stdout.trim();
            // In Whitelist mode, the ONLY allowed app is the ONE currently selected (whitelistedApp)
            // or LockIn/electron itself.
            const allowedApps = ['electron', 'test01', 'LockIn', whitelistedApp];

            if (activeAppName && activeAppName !== "Unknown" && !allowedApps.includes(activeAppName)) {
                console.log(`Violation! Active: ${activeAppName}, Allowed: ${whitelistedApp}`);
                isRecovering = true;

                if (whitelistedApp) {
                    focusExternalApp(whitelistedApp);
                } else {
                    if (win.isMinimized()) win.restore();
                    win.focus();
                }
                setTimeout(() => { isRecovering = false; }, 1000);
            }
        }
    });
}

function createWindow() {
    win = new BrowserWindow({
        width: 600,
        height: 750,
        frame: false,
        transparent: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile('index.html');
}

ipcMain.on('close-app', () => {
    app.quit();
});

// IPC Handlers for Focus Mode
function handleBlur() {
    if (win) {
        if (win.isMinimized()) {
            win.restore();
        }
        win.focus();
        win.setAlwaysOnTop(true, 'screen-saver');
        win.webContents.send('window-blur'); // Send event if UI wants to know
    }
}

ipcMain.on('start-hard-lock', () => {
    if (win) {
        win.setKiosk(true);
        win.setAlwaysOnTop(true, 'screen-saver');

        // Prevent minimize and regain focus
        win.on('blur', handleBlur);

        // Block Alt+Tab
        const shortcuts = ['Alt+Tab', 'CmdOrCtrl+Tab'];
        shortcuts.forEach(shortcut => {
            try { globalShortcut.register(shortcut, () => { console.log(`${shortcut} blocked`); }); }
            catch (e) { console.error(`Error registering ${shortcut}:`, e); }
        });
    }
});

ipcMain.on('start-floating-timer', () => {
    if (win) {
        win.setKiosk(false);
        // Slightly taller PiP size to fit the unlock button
        win.setSize(240, 140);
        // Bottom right corner geometry
        const { width, height } = require('electron').screen.getPrimaryDisplay().workAreaSize;
        win.setPosition(width - 260, height - 160);

        win.setAlwaysOnTop(true, 'screen-saver');
        win.removeListener('blur', handleBlur);
    }
});

ipcMain.handle('get-apps', async () => {
    return new Promise((resolve) => {
        const psScript = "$apps = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and [string]::IsNullOrWhiteSpace($_.MainWindowTitle) -eq $false }; $list = @(); foreach ($app in $apps) { $list += [PSCustomObject]@{ Name = $app.Name; MainWindowTitle = $app.MainWindowTitle } }; $list | ConvertTo-Json -Compress";

        // Use base64 encoding to completely bypass quote escaping issues in Command Prompt / Node exec
        const base64Cmd = Buffer.from(psScript, 'utf16le').toString('base64');

        exec(`powershell -NoProfile -EncodedCommand ${base64Cmd}`, (error, stdout) => {
            if (error) { resolve([]); return; }
            try {
                let cleanOut = stdout.trim();
                // Remove potential byte order marks
                if (cleanOut.charCodeAt(0) === 0xFEFF) cleanOut = cleanOut.slice(1);

                const apps = JSON.parse(cleanOut);
                const uniqueApps = [];
                const names = new Set();
                const ignoreList = ['electron', 'test01', 'LockIn', 'explorer', 'cmd', 'conhost', 'SearchIndexer', 'TextInputHost'];

                for (let app of [].concat(apps)) {
                    if (app.Name && !names.has(app.Name) && !ignoreList.includes(app.Name)) {
                        names.add(app.Name);
                        uniqueApps.push(app);
                    }
                }
                resolve(uniqueApps);
            } catch (e) {
                console.error("Failed to parse apps:", e);
                resolve([]);
            }
        });
    });
});

ipcMain.on('start-whitelist-lock', (event, appNamesArray) => {
    if (win) {
        selectedAppsArray = appNamesArray;
        whitelistedApp = appNamesArray[0]; // Set initial app
        win.setKiosk(true);
        // FORCE ALWAYS ON TOP 'normal' (TopMost) to hide taskbar and block Alt+Tab views!
        win.setAlwaysOnTop(true, 'normal');
        win.removeListener('blur', handleBlur);

        // STRICT SANDBOX: Block Alt+Tab
        const shortcuts = ['Alt+Tab', 'CmdOrCtrl+Tab'];
        shortcuts.forEach(shortcut => {
            try { globalShortcut.register(shortcut, () => { console.log(`${shortcut} blocked in Whitelist`); }); }
            catch (e) { console.error(`Error registering ${shortcut}:`, e); }
        });

        if (whitelistInterval) clearInterval(whitelistInterval);
        whitelistInterval = setInterval(checkActiveWindow, 500); // Poll faster
    }
});

ipcMain.on('focus-external-app', (event, appName) => {
    focusExternalApp(appName);
});

ipcMain.on('stop-lock', () => {
    if (win) {
        if (whitelistInterval) {
            clearInterval(whitelistInterval);
            whitelistInterval = null;
        }

        // Remove topmost from all selected apps
        if (selectedAppsArray && selectedAppsArray.length > 0) {
            const joinedApps = selectedAppsArray.join(',');
            const psScript = `
                Add-Type -TypeDefinition @"
                using System;
                using System.Runtime.InteropServices;
                public class Win32 {
                    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
                }
"@
                $HWND_NOTOPMOST = New-Object IntPtr(-2)
                $allApps = "${joinedApps}" -split ","
                foreach ($name in $allApps) {
                    $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
                    if ($p) {
                        foreach ($proc in $p) {
                            [Win32]::SetWindowPos($proc.MainWindowHandle, $HWND_NOTOPMOST, 0,0,0,0, 3)
                        }
                    }
                }
            `;
            const base64Cmd = Buffer.from(psScript, 'utf16le').toString('base64');
            exec(`powershell -NoProfile -EncodedCommand ${base64Cmd}`);
        }

        whitelistedApp = null;
        selectedAppsArray = [];

        win.setKiosk(false);
        win.setSize(600, 750);
        win.center();
        win.setAlwaysOnTop(false);
        win.removeListener('blur', handleBlur);
        globalShortcut.unregisterAll();
    }
});

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
});
