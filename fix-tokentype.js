#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Path to watcher.js file
const watcherFilePath = path.join(__dirname, 'src/services/watcher.js');

// Read the file
let content = fs.readFileSync(watcherFilePath, 'utf8');

// Fix the token type reference error
let fixedContent = content.replace(
  /if \(isWatched\) \{\s*console\.log\(`\\n🎯 Detected \${tokenType} transfer to watched wallet \${to}\!`\);\s*console\.log\(`Transaction details:\\n - Hash: \${txHash}\\n - From: \${from}\\n - Value: \${value\.toString\(\)} \${tokenType}`\);/,
  `if (isWatched) {
            // Determine token type (USDC or WETH) before logging
            const usdcAddress = process.env.USDC_CONTRACT_ADDRESS.toLowerCase();
            const wethAddress = '0x4200000000000000000000000000000000000006'.toLowerCase();
            
            // Get token type based on contract address
            let tokenType = 'UNKNOWN';
            if (tokenAddress === usdcAddress) {
              tokenType = 'USDC';
            } else if (tokenAddress === wethAddress) {
              tokenType = 'WETH';
            } else {
              tokenType = 'ERC20';
            }
            
            console.log(\`\\n🎯 Detected \${tokenType} transfer to watched wallet \${to}!\`);
            console.log(\`Transaction details:\\n - Hash: \${txHash}\\n - From: \${from}\\n - Value: \${value.toString()} \${tokenType}\`);`
);

// Remove the redundant tokenType declaration if needed
fixedContent = fixedContent.replace(
  /let tokenType;\s*if \(tokenAddress === usdcAddress\) \{\s*tokenType = 'USDC';/,
  `// Token type already defined above
            if (tokenAddress === usdcAddress) {
              // Maintain the value for compatibility
              tokenType = 'USDC';`
);

// Check if we made a successful change
if (fixedContent !== content) {
  // Write the fixed content to the file
  fs.writeFileSync(watcherFilePath, fixedContent, 'utf8');
  console.log('✅ Fixed the tokenType reference error in watcher.js');
} else {
  console.log('⚠️ Could not find the specific code pattern to fix. Manual intervention may be required.');
}

console.log('Restart the server to apply changes.');
