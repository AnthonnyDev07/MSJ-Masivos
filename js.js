const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();

// --- CONFIGURACIÓN ---

// 1. Asegurar que la carpeta 'uploads' exista
const uploadsDir = './uploads';
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// 2. Configurar Multer para manejar múltiples archivos
const upload = multer({
    dest: uploadsDir
}).fields([
    { name: 'archivoExcel', maxCount: 1 },
    { name: 'archivoImagen', maxCount: 1 }
]);

// 3. Configuración del Cliente de WhatsApp
let clientReady = false;
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('--- ESCANEA ESTE CÓDIGO QR CON TU WHATSAPP ---');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('¡CLIENTE DE WHATSAPP LISTO!');
    clientReady = true;
});

client.on('auth_failure', msg => {
    console.error('ERROR DE AUTENTICACIÓN:', msg);
});

client.initialize();


// --- RUTAS DEL SERVIDOR ---

// 1. Servir la página web principal
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Ruta para procesar el Excel y enviar mensajes
app.post('/enviar-mensajes', upload, async (req, res) => {
    // Validaciones iniciales
    if (!clientReady) {
        return res.status(503).json({ error: 'El cliente de WhatsApp no está listo. Escanea el QR y espera el mensaje de confirmación.' });
    }
    if (!req.files || !req.files.archivoExcel) {
        return res.status(400).json({ error: 'No se subió el archivo Excel.' });
    }
    if (!req.body.mensaje) {
        return res.status(400).json({ error: 'El campo del mensaje no puede estar vacío.' });
    }

    const excelFile = req.files.archivoExcel[0];
    const imagenFile = req.files.archivoImagen ? req.files.archivoImagen[0] : null;

    try {
        const workbook = xlsx.readFile(excelFile.path);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        console.log(`Iniciando proceso para ${data.length} contactos...`);
        let enviados = 0;
        let errores = 0;

        let media = null;
        let tempImagePath = null; // Guardará la ruta del archivo renombrado
        if (imagenFile) {
            console.log(`Adjuntando imagen: ${imagenFile.originalname}`);
            // Renombrar el archivo temporal para que conserve su extensión original
            tempImagePath = imagenFile.path + path.extname(imagenFile.originalname);
            fs.renameSync(imagenFile.path, tempImagePath);
            
            // Crear el media desde el archivo ya con su extensión correcta
            media = MessageMedia.fromFilePath(tempImagePath);
        }

        for (const fila of data) {
            const nombre = fila.NOMBRE || '';
            let numero = String(fila.NUMERO || '').replace(/\D/g, '');

            if (numero) {
                const chatId = `${numero}@c.us`;
                const mensajePersonalizado = req.body.mensaje.replace(/{nombre}/g, nombre).trim();

                try {
                    if (media) {
                        // Enviar imagen con caption
                        await client.sendMessage(chatId, media, { caption: mensajePersonalizado });
                    } else {
                        // Enviar solo texto
                        await client.sendMessage(chatId, mensajePersonalizado);
                    }
                    console.log(` -> Enviado a ${nombre} (${numero})`);
                    enviados++;
                } catch (err) {
                    console.error(` -> Error enviando a ${nombre} (${numero}):`, err.message);
                    errores++;
                }
                
                // Pausa prudencial para evitar bloqueo
                await new Promise(resolve => setTimeout(resolve, 3000)); // 3 segundos
            } else {
                console.log(` -> Fila omitida (sin número válido): ${JSON.stringify(fila)}`);
                errores++;
            }
        }

        res.json({
            mensaje: 'Proceso terminado',
            total: data.length,
            enviados,
            errores
        });

    } catch (error) {
        console.error('Error fatal procesando la solicitud:', error);
        res.status(500).json({ error: 'Error procesando el archivo. Asegúrate que el formato del Excel es correcto.' });
    } finally {
        // Limpiar archivos subidos
        fs.unlinkSync(excelFile.path);
        if (imagenFile) {
            fs.unlinkSync(imagenFile.path);
        }
        console.log('--- Proceso finalizado. Archivos temporales eliminados. ---');
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log('Esperando la inicialización del cliente de WhatsApp...');
});
