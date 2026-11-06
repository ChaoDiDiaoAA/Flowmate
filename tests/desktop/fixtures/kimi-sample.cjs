const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  app.accessibilitySupportEnabled = true;
  const window = new BrowserWindow({ width: 500, height: 240, show: true, title: 'Flowmate KimiCU Controlled Sample' });
  window.loadURL('data:text/html,' + encodeURIComponent('<!doctype html><title>Flowmate KimiCU Controlled Sample</title><main><label for="amount">Sample amount</label><input id="amount" aria-label="Sample amount" value="0.00"><p>Test data only</p></main>'));
});
app.on('window-all-closed', () => app.quit());
