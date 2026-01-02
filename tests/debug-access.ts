import { createX3Client, createTestAccount, uniqueChannel } from './src/helpers/index.js';

async function debugAccess() {
  const client = await createX3Client();
  const { account, password, email } = await createTestAccount();
  const channel = uniqueChannel();
  
  console.log('=== Registering account ===');
  const regResult = await client.registerAndActivate(account, password, email);
  console.log('Account registration:', regResult.success ? 'SUCCESS' : 'FAILED');
  
  console.log('\n=== Authenticating ===');
  const authResult = await client.auth(account, password);
  console.log('Auth:', authResult.success ? 'SUCCESS' : 'FAILED');
  
  console.log('\n=== Joining channel ===');
  client.send(`JOIN ${channel}`);
  await client.waitForLine(/JOIN/i, 5000);
  await new Promise(r => setTimeout(r, 500));
  
  console.log('\n=== Registering channel ===');
  const chanResult = await client.registerChannel(channel);
  console.log('Channel register response lines:');
  chanResult.lines.forEach((l, i) => console.log(`  ${i}: ${l}`));
  console.log('Success:', chanResult.success);
  
  console.log('\n=== Getting ACCESS list ===');
  client.clearRawBuffer();
  client.send(`PRIVMSG ChanServ :ACCESS ${channel} *`);
  
  // Wait and collect all responses
  const responses: string[] = [];
  const start = Date.now();
  while (Date.now() - start < 5000) {
    try {
      const line = await client.waitForLine(/NOTICE/i, 1000);
      responses.push(line);
    } catch {
      if (responses.length > 0) break;
    }
  }
  
  console.log('ACCESS command responses:');
  responses.forEach((l, i) => console.log(`  ${i}: ${l}`));
  
  client.close();
  console.log('\nDone!');
}

debugAccess().catch(console.error);
