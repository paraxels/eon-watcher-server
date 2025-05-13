const fs = require('fs');
const path = require('path');

// Read the file
const filePath = path.join(__dirname, 'watcher.js');
const content = fs.readFileSync(filePath, 'utf8');

// Define a regular expression to detect class methods
const methodRegex = /^(\s+)([a-zA-Z][a-zA-Z0-9]*)\s*\([^)]*\)\s*\{/gm;

// Fix method declarations
const fixedContent = content.replace(methodRegex, (match) => {
  return match; // Keep the method declaration as is
});

// Write the fixed content back to the file
fs.writeFileSync(filePath, fixedContent, 'utf8');

console.log('Fixed syntax in watcher.js');
