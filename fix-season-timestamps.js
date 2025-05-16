#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Path to seasonGoals.js file
const seasonGoalsPath = path.join(__dirname, 'src/services/seasonGoals.js');

// Read the file
console.log(`Reading ${seasonGoalsPath}`);
let content = fs.readFileSync(seasonGoalsPath, 'utf8');

// Pattern 1: Fix the checkAndAdjustDonation method
let updated = content.replace(
  /const startTimestamp = season\.startDate \? Math\.floor\(new Date\(season\.startDate\)\.getTime\(\) \/ 1000\) : 0;/g,
  `// If no explicit start date, use the timestamp when the season record was created
      const startTimestamp = season.startDate ? Math.floor(new Date(season.startDate).getTime() / 1000) : 
        (season.timestamp ? Math.floor(new Date(season.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400); // Default to 1 day ago if no timestamp
      console.log(\`Season period starting at: \${new Date(startTimestamp * 1000).toISOString()}\`);`
);

// Pattern 2: Fix the checkSeasonGoalProgress method (if it also has the issue)
updated = updated.replace(
  /const startTimestamp = season\.startDate \? Math\.floor\(new Date\(season\.startDate\)\.getTime\(\) \/ 1000\) : 0;/g,
  `// If no explicit start date, use the timestamp when the season record was created
      const startTimestamp = season.startDate ? Math.floor(new Date(season.startDate).getTime() / 1000) : 
        (season.timestamp ? Math.floor(new Date(season.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000) - 86400); // Default to 1 day ago if no timestamp
      console.log(\`Season period starting at: \${new Date(startTimestamp * 1000).toISOString()}\`);`
);

// Write back the file
if (updated !== content) {
  fs.writeFileSync(seasonGoalsPath, updated, 'utf8');
  console.log('✅ Updated seasonGoals.js to fix timestamp issue');
} else {
  console.log('⚠️ No changes made to seasonGoals.js');
}

// Let's also add an option to reset completed seasons
if (!content.includes('resetCompletedSeason')) {
  // Find the end of the class (the last closing brace)
  const classEnd = content.lastIndexOf('}');
  
  if (classEnd !== -1) {
    // Insert the reset method before the class closing
    const resetMethod = `
  /**
   * Reset a completed season to active status
   * @param {string} seasonId - ID of the season to reset
   * @returns {Promise<boolean>} Success status
   */
  async resetCompletedSeason(seasonId) {
    try {
      const result = await ExistingWallet.findByIdAndUpdate(
        seasonId,
        { active: true, completedAt: null },
        { new: true }
      );
      
      if (result) {
        console.log(\`Reset season \${seasonId} to active status\`);
        return true;
      } else {
        console.log(\`Season \${seasonId} not found\`);
        return false;
      }
    } catch (error) {
      console.error(\`Error resetting season \${seasonId}:\`, error);
      return false;
    }
  }
`;
    
    // Insert the method
    const finalContent = content.substring(0, classEnd) + resetMethod + content.substring(classEnd);
    fs.writeFileSync(seasonGoalsPath, finalContent, 'utf8');
    console.log('✅ Added resetCompletedSeason method to seasonGoals.js');
  }
}

console.log('Done. Restart the server to apply changes.');
