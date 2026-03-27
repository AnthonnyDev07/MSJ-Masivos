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
    console.log('--- Generando QR, escanéalo con tu teléfono ---');
    qrcode.generate(qr, { small: false });
});

client.on('ready', () => {
    console.log('¡CLIENTE DE WHATSAPP LISTO!');
    clientReady = true;
});

client.on('auth_failure', msg => {
    console.error('ERROR DE AUTENTICACIÓN:', msg);
});

client.initialize();


// --- FUNCIONES AUXILIARES ---
/**
 * Genera un número aleatorio dentro de un rango.
 * @param {number} min El valor mínimo del rango.
 * @param {number} max El valor máximo del rango.
 * @returns {number} Un número entero aleatorio entre min y max.
 */
function obtenerTiempoEspera(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Traduce un mensaje de error técnico a uno más amigable para el usuario.
 * @param {string} errorMessage El mensaje de error original.
 * @returns {string} Un mensaje de error fácil de entender.
 */
function traducirError(errorMessage) {
    if (!errorMessage) return 'Error desconocido.';
    
    const lowerCaseError = errorMessage.toLowerCase();

    if (lowerCaseError.includes('not a contact') || lowerCaseError.includes('invalid wid')) {
        return 'El número de teléfono no es válido o no tiene WhatsApp.';
    }
    if (lowerCaseError.includes('session closed') || lowerCaseError.includes('disconnected')) {
        return 'La conexión con WhatsApp se interrumpió. Revisa tu teléfono y la conexión a internet.';
    }
    if (lowerCaseError.includes('timeout')) {
        return 'Tiempo de espera agotado. Puede haber un problema de conexión.';
    }
    // Mensaje por defecto si no se identifica un error común
    return 'No se pudo enviar. Revisa el número de teléfono.';
}


// --- RUTAS DEL SERVIDOR ---

app.use(express.static(__dirname));

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

    // Headers para streaming de respuesta
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Transfer-Encoding', 'chunked');

    const excelFile = req.files.archivoExcel[0];
    const imagenFile = req.files.archivoImagen ? req.files.archivoImagen[0] : null;

    // Función para enviar eventos de progreso
    const sendProgress = (data) => {
        res.write(JSON.stringify(data) + '\n');
    };

    try {
        const workbook = xlsx.readFile(excelFile.path);
        const sheetName = workbook.SheetNames[0];
        const data = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        sendProgress({ type: 'start', total: data.length });

        let enviados = 0;
        let errores = 0;
        let media = null;
        let tempImagePath = null;

        if (imagenFile) {
            tempImagePath = imagenFile.path + path.extname(imagenFile.originalname);
            fs.renameSync(imagenFile.path, tempImagePath);
            media = MessageMedia.fromFilePath(tempImagePath);
        }

        for (let i = 0; i < data.length; i++) {
            const fila = data[i];
            const nombre = fila.NOMBRE || 'N/A';
            let numero = String(fila.NUMERO || '').replace(/\D/g, '');
            let status = 'pendiente';
            let errorMsg = null;

            if (numero) {
                const chatId = `${numero}@c.us`;
                const mensajePersonalizado = req.body.mensaje.replace(/{nombre}/g, nombre).trim();

                try {
                    if (media) {
                        await client.sendMessage(chatId, media, { caption: mensajePersonalizado });
                    } else {
                        await client.sendMessage(chatId, mensajePersonalizado);
                    }
                    console.log(` -> Enviado a ${nombre} (${numero})`);
                    status = 'enviado';
                    enviados++;
                } catch (err) {
                    console.error(` -> Error enviando a ${nombre} (${numero}):`, err.message);
                    status = 'error';
                    errorMsg = traducirError(err.message);
                    errores++;
                }
            } else {
                console.log(` -> Fila omitida (sin número válido): ${JSON.stringify(fila)}`);
                status = 'omitido';
                errores++;
            }
            
            const tiempoEspera = (i < data.length - 1) ? obtenerTiempoEspera(5000, 15000) : 0;

            sendProgress({
                type: 'progress',
                data: {
                    index: i + 1,
                    nombre,
                    numero,
                    status,
                    errorMsg,
                    tiempoEspera: tiempoEspera / 1000
                }
            });

            if (tiempoEspera > 0) {
                console.log(`   ...esperando ${tiempoEspera / 1000} segundos...`);
                await new Promise(resolve => setTimeout(resolve, tiempoEspera));
            }
        }

        sendProgress({ type: 'done', data: { total: data.length, enviados, errores } });
        res.end();

    } catch (error) {
        console.error('Error fatal procesando la solicitud:', error);
        const errorResponse = {
            type: 'error',
            error: 'Error procesando el archivo. Asegúrate que el formato del Excel es correcto.',
            detalle: error.message
        };
        // Si los encabezados ya se enviaron, no podemos cambiar el status code.
        // Enviamos el error como parte del stream.
        if (res.headersSent) {
            res.write(JSON.stringify(errorResponse) + '\n');
            res.end();
        } else {
            // Si no, podemos enviar una respuesta de error normal.
            res.status(500).json(errorResponse);
        }
    } finally {
        // Limpiar archivos subidos
        if (excelFile && fs.existsSync(excelFile.path)) {
            fs.unlinkSync(excelFile.path);
        }
        if (imagenFile && fs.existsSync(imagenFile.path)) {
             fs.unlinkSync(imagenFile.path);
        }
        if (tempImagePath && fs.existsSync(tempImagePath)) {
             fs.unlinkSync(tempImagePath);
        }
        console.log('--- Proceso finalizado. Archivos temporales eliminados. ---');
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
    console.log('Esperando la inicialización del cliente de WhatsApp...');
});
