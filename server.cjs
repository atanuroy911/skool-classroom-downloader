const http = require('http');
const fs = require('fs');

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.end();
    return;
  }
  
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = Buffer.concat(chunks).toString('utf8');
      fs.writeFileSync('C:/Users/atanu/Desktop/TEST/lesson-data.json', body);
      const data = JSON.parse(body);
      console.log('SAVED', data.lessons?.length, 'lessons');
      res.end('OK');
    } catch (err) {
      console.error('Error saving data:', err.message);
      res.statusCode = 400;
      res.end(err.message);
    }
  });
}).listen(9876, () => console.log('Save server listening on port 9876'));
