require('dotenv').config();
const mongoose = require('mongoose');
const ExistingWallet = require('./src/models/ExistingWallet');

async function checkWallets() {
  try {
    // MongoDB connection URI
    const uri = process.env.DB_STRING;
    console.log(`Connecting to MongoDB...`);
    
    // Connect to MongoDB
    await mongoose.connect(uri);
    console.log('Connected to MongoDB!');
    
    // Query all active wallets
    const wallets = await ExistingWallet.find({ active: true });
    console.log(`\nFound ${wallets.length} active wallet configurations:\n`);
    
    // Display wallet information 
    wallets.forEach((wallet, index) => {
      const walletAddress = wallet.walletAddress ? wallet.walletAddress.toLowerCase() : 'null';
      const target = wallet.target ? wallet.target.toLowerCase() : 'null';
      
      console.log(`${index + 1}. Wallet: ${walletAddress}`);
      console.log(`   Target: ${target}`);
      console.log(`   Percentage: ${wallet.percentAmount}%`);
      console.log(`   Active: ${wallet.active}`);
      console.log(`   ID: ${wallet._id}`);
      console.log();
    });
    
    // Check for our specific wallet - FORCE LOWERCASE
    const specificWallet = '0x027fa2585de8ebaf2c1d3e73130e928185965c24';
    console.log(`Checking for specific wallet: ${specificWallet}`);
    
    const specificWalletConfigs = wallets.filter(w => 
      w.walletAddress && w.walletAddress.toLowerCase() === specificWallet);
    
    console.log(`Found ${specificWalletConfigs.length} configurations for ${specificWallet}`);
    
    specificWalletConfigs.forEach((wallet, index) => {
      console.log(`\nConfig ${index + 1}:`);
      console.log(`   Original wallet case: ${wallet.walletAddress}`);
      console.log(`   Original target case: ${wallet.target}`);
      console.log(`   Percentage: ${wallet.percentAmount}%`);
      console.log(`   Created: ${wallet.timestamp}`);
    });
    
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Close MongoDB connection
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed.');
  }
}

// Run the function
checkWallets()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
