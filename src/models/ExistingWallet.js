const mongoose = require('mongoose');

// This is a flexible schema that doesn't enforce strict validation
// It allows us to read from your existing database regardless of exact structure
const existingWalletSchema = new mongoose.Schema({
  // We'll accept any fields that exist in your database
  // The only fields we absolutely need are address and some form of donation configuration
}, { 
  strict: false, // Allow any fields from the database
  collection: 'season_records', // Updated collection name (previously transaction_records)
  timestamps: false // Don't add our own timestamps
});

module.exports = mongoose.model('ExistingWallet', existingWalletSchema);
