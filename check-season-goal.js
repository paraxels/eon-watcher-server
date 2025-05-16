require('dotenv').config();
const mongoose = require('mongoose');
const seasonGoalService = require('./src/services/seasonGoals');

// Command line argument for wallet address
const walletAddress = process.argv[2];

if (!walletAddress) {
  console.error('Please provide a wallet address as an argument');
  console.log('Usage: node check-season-goal.js 0x123456789...');
  process.exit(1);
}

async function main() {
  try {
    // Connect to the database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    console.log(`Checking season goal progress for wallet: ${walletAddress}`);
    const result = await seasonGoalService.checkSeasonGoalProgress(walletAddress);
    
    if (result.success) {
      console.log('\nSeason Goal Progress:');
      console.log('====================');
      console.log(`Wallet: ${result.walletAddress}`);
      console.log(`Season Start: ${result.seasonStart}`);
      console.log(`Season End: ${result.seasonEnd}`);
      console.log(`Goal Amount: ${formatUsdc(result.goalAmount)} USDC`);
      console.log(`Total Donated: ${formatUsdc(result.totalDonated)} USDC`);
      console.log(`Progress: ${result.percentComplete}%`);
      console.log(`Goal Met: ${result.isGoalMet ? 'YES! 🎉' : 'Not yet'}`);
      console.log(`Number of Transactions: ${result.transactionCount}`);
    } else {
      console.error('Failed to check season goal:', result.error);
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Disconnect from database
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Helper function to format USDC amounts (from smallest unit to decimal representation)
function formatUsdc(amountInSmallestUnit) {
  // Assuming USDC has 6 decimal places
  const decimalPlaces = 6;
  const amountBigInt = BigInt(amountInSmallestUnit);
  const divisor = BigInt(10 ** decimalPlaces);
  
  const wholePart = amountBigInt / divisor;
  const fractionalPart = amountBigInt % divisor;
  
  // Format fractional part with leading zeros
  const fractionalString = fractionalPart.toString().padStart(decimalPlaces, '0');
  
  return `${wholePart}.${fractionalString}`;
}

main().catch(console.error);
