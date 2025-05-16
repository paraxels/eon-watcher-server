require('dotenv').config();
const mongoose = require('mongoose');
const ExistingWallet = require('./src/models/ExistingWallet');

async function main() {
  try {
    // Connect to the database
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // Get a count of all records
    const count = await ExistingWallet.countDocuments();
    console.log(`Total records in season_records collection: ${count}`);

    // Get the first 5 records to examine their structure
    const sampleRecords = await ExistingWallet.find().limit(5);
    console.log('\nSample records structure:');
    sampleRecords.forEach((record, index) => {
      console.log(`\nRecord ${index + 1}:`);
      console.log(JSON.stringify(record, null, 2));
    });

    // Search for the specific wallet with case-insensitive matching
    const walletAddress = '0xCb8043841904f69952C334bba47Fd769445EB074';
    console.log(`\nLooking for records with address: ${walletAddress} (case-insensitive)`);
    
    // Try to find any record that might contain this address
    const regex = new RegExp(walletAddress.replace(/0x/i, ''), 'i');
    
    // This will match the address in any field that might contain it
    const possibleRecords = await ExistingWallet.find({
      $or: [
        { address: { $regex: regex } },
        { wallet: { $regex: regex } },
        { walletAddress: { $regex: regex } }
      ]
    });
    
    console.log(`Found ${possibleRecords.length} records that might be related to this wallet`);
    
    if (possibleRecords.length > 0) {
      possibleRecords.forEach((record, index) => {
        console.log(`\nPossible match ${index + 1}:`);
        console.log(JSON.stringify({
          id: record._id,
          address: record.address,
          wallet: record.wallet,
          walletAddress: record.walletAddress,
          dollarAmount: record.dollarAmount,
          active: record.active
        }, null, 2));
      });
    }

    // List all fields used in the collection
    const allRecords = await ExistingWallet.find({});
    const allFields = new Set();
    
    allRecords.forEach(record => {
      Object.keys(record._doc || record).forEach(key => {
        if (key !== '_id' && key !== '__v') {
          allFields.add(key);
        }
      });
    });
    
    console.log('\nAll fields used in the collection:');
    console.log(Array.from(allFields));

  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Disconnect from database
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

main().catch(console.error);
