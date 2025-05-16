require('dotenv').config();
const mongoose = require('mongoose');
const TransactionRecord = require('./src/models/TransactionRecord');

async function main() {
  try {
    // Connect to the database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Get one transaction record for the wallet
    const txRecord = await TransactionRecord.findOne({ 
      'donation.from': new RegExp('0xCb8043841904f69952C334bba47Fd769445EB074', 'i')
    });
    
    if (txRecord) {
      console.log('Transaction record found:');
      console.log(JSON.stringify(txRecord, null, 2));
      
      // Also log the donation object specifically
      console.log('\nDonation object structure:');
      console.log(JSON.stringify(txRecord.donation, null, 2));
      
      // Log all field names in the donation object
      console.log('\nDonation fields:');
      console.log(Object.keys(txRecord.donation._doc || txRecord.donation));
    } else {
      console.log('No transaction records found for this wallet');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Disconnect from database
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

main().catch(console.error);
