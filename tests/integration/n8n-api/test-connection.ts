/**
 * Quick test script to verify n8n API connection
 */

import { getN8nCredentials } from './utils/credentials';
import { getTestN8nClient } from './utils/n8n-client';

async function testConnection() {
  try {
    console.log('Loading credentials...');
    const creds = getN8nCredentials();
    console.log('Credentials loaded:', {
      url: creds.url,
      hasApiKey: !!creds.apiKey,
      apiKeyLength: creds.apiKey?.length
    });

    console.log('\nCreating n8n client...');
    const client = getTestN8nClient();
    console.log('Client created successfully');

    console.log('\nTesting health check...');
    const health = await client.healthCheck();
    console.log('Health check result:', health);

    console.log('\n✅ Connection test passed!');
  } catch (error) {
    console.error('❌ Connection test failed:');
    console.error(error);
    process.exit(1);
  }
}

testConnection();
