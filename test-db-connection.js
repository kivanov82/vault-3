const { Client } = require('pg');

// Test database connection
async function testConnection() {
  const client = new Client({
    host: '/cloudsql/bright-union:europe-west1:vault3-db',
    database: 'vault3',
    user: 'vault3user',
    password: 'k(PF4`ppk$hSr?SP',
    port: 5432,
  });

  try {
    console.log('Attempting to connect to Cloud SQL...');
    await client.connect();
    console.log('✅ Successfully connected to Cloud SQL!');

    const res = await client.query('SELECT NOW() as current_time, version() as postgres_version');
    console.log('\n📊 Database Info:');
    console.log('Current time:', res.rows[0].current_time);
    console.log('PostgreSQL version:', res.rows[0].postgres_version);

    // Test if we can create tables
    const dbCheck = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    console.log('\n📋 Existing tables:', dbCheck.rows.length > 0 ? dbCheck.rows.map(r => r.table_name).join(', ') : 'None');

    await client.end();
    console.log('\n✅ Connection test successful!');
    return true;
  } catch (error) {
    console.error('❌ Connection failed:', error.message);

    // Try localhost connection (for Cloud SQL Proxy)
    console.log('\n🔄 Trying localhost connection (Cloud SQL Proxy)...');
    const localClient = new Client({
      host: 'localhost',
      database: 'vault3',
      user: 'vault3user',
      password: 'k(PF4`ppk$hSr?SP',
      port: 5432,
    });

    try {
      await localClient.connect();
      console.log('✅ Connected via localhost (Cloud SQL Proxy is running!)');

      const res = await localClient.query('SELECT NOW() as current_time');
      console.log('Current time:', res.rows[0].current_time);

      await localClient.end();
      console.log('\n✅ Connection test successful via Cloud SQL Proxy!');
      return true;
    } catch (localError) {
      console.error('❌ Localhost connection also failed:', localError.message);
      console.log('\n💡 Suggestions:');
      console.log('1. Make sure Cloud SQL Proxy is running: ./cloud-sql-proxy bright-union:europe-west1:vault3-db');
      console.log('2. Or enable public IP and authorize your IP address in Cloud SQL');
      console.log('3. Check that the database "vault3" and user "vault3user" exist');
      return false;
    }
  }
}

testConnection()
  .then(success => process.exit(success ? 0 : 1))
  .catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
