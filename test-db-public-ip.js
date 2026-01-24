const { Client } = require('pg');

// Test database connection via public IP
async function testConnection() {
  const client = new Client({
    host: '35.195.167.186',  // Cloud SQL public IP
    database: 'vault3',
    user: 'vault3user',
    password: 'VaultPass123!654',
    port: 5432,
    ssl: {
      rejectUnauthorized: false  // Accept self-signed certificates from Cloud SQL
    }
  });

  try {
    console.log('🔌 Connecting to Cloud SQL via public IP...');
    console.log('   Host: 35.195.167.186');
    console.log('   Database: vault3');
    console.log('   User: vault3user');
    console.log('');

    await client.connect();
    console.log('✅ Successfully connected to Cloud SQL!\n');

    // Test query
    const res = await client.query('SELECT NOW() as current_time, version() as postgres_version');
    console.log('📊 Database Info:');
    console.log('   Current time:', res.rows[0].current_time);
    console.log('   PostgreSQL version:', res.rows[0].postgres_version.split('\n')[0]);
    console.log('');

    // Check existing tables
    const tablesRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log('📋 Existing tables:', tablesRes.rows.length > 0
      ? tablesRes.rows.map(r => r.table_name).join(', ')
      : 'None (ready for Prisma migration!)');
    console.log('');

    await client.end();
    console.log('✅ Connection test successful!\n');
    console.log('🎉 Database is ready! You can now:');
    console.log('   1. Install Prisma: npm install -D prisma @prisma/client');
    console.log('   2. Initialize schema: Copy schema from IMPLEMENTATION_GUIDE.md');
    console.log('   3. Run migration: npx prisma migrate dev --name init');

    return true;
  } catch (error) {
    console.error('❌ Connection failed:', error.message);
    console.log('\n🔍 Troubleshooting:');
    console.log('   - Check that IP 80.115.165.243 is in authorized networks');
    console.log('   - Verify vault3user exists with correct password');
    console.log('   - Verify vault3 database exists');
    console.log('   - Check Cloud SQL instance is running');
    return false;
  }
}

testConnection()
  .then(success => process.exit(success ? 0 : 1))
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
