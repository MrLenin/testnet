import { X3Client } from './src/helpers/x3-client';
import { X3_ADMIN } from './src/helpers';

async function diagnose() {
  const host = process.env.IRC_HOST || 'localhost';
  const port = 6667;
  console.log('=== X3 Diagnostic Test ===');
  console.log(`Server: ${host}:${port}`);
  console.log(`Admin: ${X3_ADMIN.account}`);
  
  const client = new X3Client();
  await client.connect(host, port);
  
  await client.capLs();
  client.capEnd();
  client.register('diagtest');
  await client.waitForLine(/001/);
  console.log('Connected and registered');
  
  // Wait for welcome messages to settle
  await new Promise(r => setTimeout(r, 500));
  
  // Try to auth
  client.clearRawBuffer();
  console.log('\nSending AUTH command...');
  client.send(`PRIVMSG AuthServ :AUTH ${X3_ADMIN.account} ${X3_ADMIN.password}`);
  
  // Wait and check raw responses
  await new Promise(r => setTimeout(r, 2000));
  
  console.log('\nAll messages received:');
  const allLines = client.getAllLines();
  allLines.slice(-20).forEach((l, i) => console.log(`  [${i}] ${l.raw}`));
  
  // Try myAccess
  console.log('\nCalling myAccess()...');
  client.clearRawBuffer();
  const level = await client.myAccess();
  console.log(`myAccess returned: ${level}`);
  
  client.send('QUIT');
  await new Promise(r => setTimeout(r, 500));
}

diagnose().catch(console.error);
