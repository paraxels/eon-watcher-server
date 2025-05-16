#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Path to watcher.js file
const watcherFilePath = path.join(__dirname, 'src/services/watcher.js');

// Read the file
let content = fs.readFileSync(watcherFilePath, 'utf8');

// Define the changes to make (line numbers from the actual file)
const changes = [
  {
    // Remove WebSocket notification logging
    pattern: /console\.log\(`\\n⚡ WEBSOCKET NOTIFICATION: Received transaction \${txHash}`\);/g,
    replacement: '// Only log transactions relevant to watched wallets'
  },
  {
    // Remove transaction processing logs unless they're for watched wallets
    pattern: /console\.log\(`Processing transaction: \${txHash\.substring\(0, 10\)}...\`\);[\s\S]*?console\.log\(` - Value: \${tx\.value \? ethers\.formatEther\(tx\.value\) : '0'} ETH`\);/g,
    replacement: '// Only log transactions for watched wallets'
  },
  {
    // Keep the direct match logging for watched wallets
    pattern: /console\.log\(`✅ DIRECT MATCH: ETH transfer to watched wallet \${to}`\);/g,
    replacement: 'console.log(`\\n🎯 Detected ETH transfer to watched wallet ${to}`);'
  },
  {
    // Reduce ERC20 transfer logging for non-watched wallets
    pattern: /console\.log\(`\\n🔍 Examining transaction \${txHash\.substring\(0, 10\)}... for ERC20 transfers`\);[\s\S]*?console\.log\(`Watched wallets for comparison: \${watchedAddresses\.join\(', '\)}`\);/g,
    replacement: '// Only examine logs for ERC20 transfers (logging suppressed)'
  },
  {
    // Keep ERC20 transfer logging but reduce verbosity
    pattern: /console\.log\(`Found ERC20 transfer - To: \${to}, Value: \${value\.toString\(\)}`\);[\s\S]*?console\.log\(`Is recipient watched\? \${isWatched}`\);/g,
    replacement: '// Check if recipient is watched without excessive logging'
  }
];

// Apply each change
let modified = false;
changes.forEach(change => {
  const originalContent = content;
  content = content.replace(change.pattern, change.replacement);
  
  if (content !== originalContent) {
    modified = true;
  }
});

// Write the file back if changes were made
if (modified) {
  fs.writeFileSync(watcherFilePath, content, 'utf8');
  console.log('✅ Successfully reduced logging in watcher.js');
} else {
  console.log('⚠️ No changes were made to watcher.js');
}

// Additionally, add more verbose logging when watched wallet transactions are found
let enhancedContent = content;

// Enhanced logging for watched wallet transfers
enhancedContent = enhancedContent.replace(
  /if \(isWatched\) \{/g,
  `if (isWatched) {
              console.log(\`\\n🎯 Detected \${tokenType} transfer to watched wallet \${to}!\`);
              console.log(\`Transaction details:\\n - Hash: \${txHash}\\n - From: \${from}\\n - Value: \${value.toString()} \${tokenType}\`);`
);

// Check if this enhanced logging was added
if (enhancedContent !== content) {
  fs.writeFileSync(watcherFilePath, enhancedContent, 'utf8');
  console.log('✅ Added enhanced logging for watched wallet transactions');
}

console.log('Done. Restart the server to apply changes.');
