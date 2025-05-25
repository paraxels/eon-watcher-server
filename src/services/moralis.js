const Moralis = require('moralis').default;
const { EvmChain } = require('@moralisweb3/common-evm-utils');

class MoralisService {
  constructor() {
    this.isInitialized = false;
    this.streamId = null;
    this.BASE_CHAIN = EvmChain.BASE;
  }

  async init() {
    try {
      if (!process.env.MORALIS_API_KEY) {
        console.error('Missing MORALIS_API_KEY in environment variables');
        return false;
      }

      // Initialize Moralis
      await Moralis.start({
        apiKey: process.env.MORALIS_API_KEY,
      });

      this.isInitialized = true;
      console.log('Moralis initialized successfully');
      
      // Check if we have an existing stream ID in env variables
      if (process.env.MORALIS_STREAM_ID) {
        this.streamId = process.env.MORALIS_STREAM_ID;
        console.log(`Using existing Moralis stream: ${this.streamId}`);
        
        // Verify the stream exists
        await this.verifyStream();
      }
      
      return true;
    } catch (error) {
      console.error('Failed to initialize Moralis:', error);
      return false;
    }
  }

  async verifyStream() {
    try {
      if (!this.streamId) {
        console.log('No stream ID provided to verify');
        return false;
      }

      // Get all streams and look for our ID
      const streams = await Moralis.Streams.getAll({
        limit: 50
      });
      
      if (streams && streams.result) {
        const matchingStream = streams.result.find(stream => stream.id === this.streamId);
        
        if (matchingStream) {
          console.log(`Verified stream: ${matchingStream.id} | Status: ${matchingStream.status}`);
          return true;
        }
      }
      
      console.log(`Stream with ID ${this.streamId} not found`);
      this.streamId = null;
      return false;
    } catch (error) {
      console.error('Failed to verify stream, it may not exist:', error);
      this.streamId = null;
      return false;
    }
  }

  async createStream(webhookUrl, description = 'EON Watcher Stream') {
    try {
      if (!this.isInitialized) {
        console.error('Moralis not initialized');
        return null;
      }

      // Clean and validate the webhook URL
      // Make sure we have a valid webhook URL without trailing slashes
      webhookUrl = webhookUrl.trim().replace(/\/$/, '');
      
      // Validate URL format
      if (!webhookUrl.startsWith('http')) {
        console.error('Invalid webhook URL format. Must start with http:// or https://');
        return null;
      }

      console.log(`Using validated webhook URL: ${webhookUrl}`);

      // Check if we already have an existing stream
      let existingStreams;
      try {
        console.log('Checking for existing streams...');
        existingStreams = await Moralis.Streams.getAll({
          limit: 10
        });
        
        if (existingStreams && existingStreams.result && existingStreams.result.length > 0) {
          console.log(`Found ${existingStreams.result.length} existing streams`);
          
          // Log all existing streams for debugging
          existingStreams.result.forEach((stream, index) => {
            console.log(`Stream ${index + 1}: ID=${stream.id}, URL=${stream.webhookUrl}`);
          });
          
          // Look for a stream with the same webhook URL
          const matchingStream = existingStreams.result.find(
            stream => stream.webhookUrl === webhookUrl
          );
          
          if (matchingStream) {
            console.log(`Found existing stream with ID: ${matchingStream.id}`);
            this.streamId = matchingStream.id;
            return matchingStream.id;
          }
        }
      } catch (error) {
        console.error('Error checking for existing streams:', error);
        if (error.response && error.response.data) {
          console.error('API Response:', error.response.data);
        }
        // Continue to create a new stream
      }
      
      // If we reach here, we need to create a new stream
      console.log('Creating a new stream with minimal configuration...');
      
      // Webhook verification is handled by Moralis automatically
      
      // Create stream payload with the original webhook URL
      const streamPayload = {
        webhookUrl, // Use the original webhook URL
        chains: ['0x2105'], // Base Mainnet in hex format
        description,
        includeNativeTxs: true,
        tag: 'eon-watcher'
      };
      
      console.log('Creating stream with payload:', JSON.stringify(streamPayload, null, 2));
      
      // Create the stream with minimal configuration
      const stream = await Moralis.Streams.add(streamPayload);
      
      console.log('Stream creation successful:', stream);

      this.streamId = stream.id;
      console.log(`Created new Moralis stream: ${this.streamId}`);
      return this.streamId;
    } catch (error) {
      console.error('Failed to create Moralis stream:', error.message);
      
      // Extract and log detailed error information from the response
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response headers:', JSON.stringify(error.response.headers, null, 2));
        
        if (error.response.data) {
          console.error('API Error Details:', JSON.stringify(error.response.data, null, 2));
        }
      }
      
      if (error.config) {
        console.error('Request URL:', error.config.url);
        console.error('Request method:', error.config.method);
        console.error('Request data:', error.config.data);
      }
      
      return null;
    }
  }

  async updateStreamAddresses(addresses) {
    try {
      if (!this.streamId) {
        console.error('No stream ID available to update');
        return false;
      }

      if (!addresses || addresses.length === 0) {
        console.log('No addresses to update');
        return true; // Nothing to do, but not a failure
      }

      console.log(`Updating stream ${this.streamId} with ${addresses.length} addresses`);
      
      // First delete all existing addresses to ensure clean state
      try {
        // Get current addresses in the stream
        const streamDetails = await Moralis.Streams.getAddresses({
          id: this.streamId,
          limit: 100
        });
        
        if (streamDetails && streamDetails.result && streamDetails.result.length > 0) {
          console.log(`Stream has ${streamDetails.result.length} existing addresses, removing them first`);
          
          // Extract the addresses
          const existingAddresses = streamDetails.result.map(item => item.address);
          
          if (existingAddresses.length > 0) {
            // Remove all existing addresses
            await Moralis.Streams.deleteAddress({
              id: this.streamId,
              address: existingAddresses
            });
            console.log(`Removed ${existingAddresses.length} existing addresses`);
          }
        }
      } catch (error) {
        console.warn('Could not remove existing addresses:', error.message);
        // Continue anyway to add new addresses
      }
      
      // Add the new addresses using the correct Moralis API method
      await Moralis.Streams.addAddress({
        id: this.streamId,
        address: addresses
      });

      console.log(`Updated stream ${this.streamId} with ${addresses.length} addresses`);
      return true;
    } catch (error) {
      console.error('Failed to update stream addresses:', error);
      return false;
    }
  }

  async addWalletAddresses(addresses) {
    try {
      if (!this.streamId) {
        console.error('Cannot add wallets, no stream ID available');
        return false;
      }
      
      console.log(`Adding ${addresses.length} wallet addresses to Moralis stream...`);
      
      // Add addresses to the stream
      await Moralis.Streams.addAddress({
        id: this.streamId,
        address: addresses,
      });
      
      console.log(`Successfully added ${addresses.length} addresses to stream`);
      return true;
    } catch (error) {
      console.error(`Error adding wallet addresses to Moralis stream: ${error.message}`);
      return false;
    }
  }

  async updateStreamSettings(options = {}) {
    try {
      if (!this.streamId) {
        console.error('Cannot update stream settings, no stream ID available');
        return false;
      }
      
      console.log('Updating Moralis stream settings for ALL transaction monitoring...');
      
      // The simplest possible configuration to capture ALL data for our watched wallets
      // without any filtering at the source - we'll filter in our webhook handler
      const defaultOptions = {
        // Monitor all native transactions
        includeNativeTxs: true,
        
        // Include all contract logs without filtering
        includeContractLogs: true,
        
        // Enable internal transactions if available on the free plan
        includeInternalTxs: false,
      };
      
      // Merge with any custom options
      const updateOptions = {
        id: this.streamId,
        ...defaultOptions,
        ...options
      };
      
      // Remove premium features if they're set
      delete updateOptions.includeAllTxLogs;
      
      console.log('Updating stream with options:', JSON.stringify(updateOptions, null, 2));
      
      // Update the stream with new settings
      const result = await Moralis.Streams.update(updateOptions);
      
      console.log('Stream update result:', JSON.stringify(result, null, 2));
      return true;
    } catch (error) {
      console.error(`Error updating Moralis stream: ${error.message}`);
      // Don't try to stringify the entire error object to avoid circular references
      if (error.response && error.response.data) {
        console.error('API Response data:', error.response.data);
      }
      return false;
    }
  }

  async addAddressesToStream(addresses) {
    try {
      if (!this.streamId) {
        console.error('No stream ID available to update');
        return false;
      }

      // Add addresses to the stream
      await Moralis.Streams.addAddress({
        id: this.streamId,
        address: addresses
      });

      console.log(`Added ${addresses.length} addresses to stream ${this.streamId}`);
      return true;
    } catch (error) {
      console.error('Failed to add addresses to stream:', error);
      return false;
    }
  }

  async removeAddressesFromStream(addresses) {
    try {
      if (!this.streamId) {
        console.error('No stream ID available to update');
        return false;
      }

      // Remove addresses from the stream
      await Moralis.Streams.deleteAddress({
        id: this.streamId,
        address: addresses
      });

      console.log(`Removed ${addresses.length} addresses from stream ${this.streamId}`);
      return true;
    } catch (error) {
      console.error('Failed to remove addresses from stream:', error);
      return false;
    }
  }
}

module.exports = new MoralisService();
