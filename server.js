const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Ruta principal y de salud
app.get('/', (req, res) => res.send('Servidor Baileys activo'));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/status', (req, res) => res.json({ status: 'connected' }));

app.listen(PORT, () => {
  console.log(`Servidor iniciado en puerto ${PORT}`);
});
