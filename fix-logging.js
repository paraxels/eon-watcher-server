#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Path to watcher.js file
const watcherFilePath = path.join(__dirname, 'src/services/watcher.js');

// Read the file
let content = fs.readFileSync(watcherFilePath, 'utf8');

// Fix the isWatched not defined error
// Look for the section in processReceiptLogsForERC20 where it's used
const fixedContent = content.replace(
  /if \(isWatched\) \{/g,
  `const isWatched = this.watchedWallets.has(to);
          if (isWatched) {`
);

// Write the file back
fs.writeFileSync(watcherFilePath, fixedContent, 'utf8');
console.log('✅ Fixed the isWatched reference error in watcher.js');
console.log('Restart the server to apply changes.');
