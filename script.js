// Variable global para almacenar el número total de contactos a procesar.
let totalContactos = 0;

/**
 * Función principal que se ejecuta al hacer clic en el botón "Enviar Mensajes".
 * Recopila los datos del formulario, los envía al servidor y procesa la respuesta en tiempo real.
 */
async function enviarMensajes() {
    totalContactos = 0; // Reinicia el contador de contactos en cada nuevo envío.

    // Obtiene las referencias a los elementos del DOM.
    const fileInput = document.getElementById('excelFile');
    const imagenInput = document.getElementById('imagen');
    const mensajeText = document.getElementById('mensaje').value;
    const btn = document.getElementById('btnEnviar');
    const resultadoDiv = document.getElementById('resultado');
    const logsContainer = document.getElementById('logs-container');
    const successLog = document.getElementById('success-log');
    const errorLog = document.getElementById('error-log');

    // Validaciones básicas antes de enviar.
    if (fileInput.files.length === 0) {
        alert('Por favor, selecciona un archivo Excel.');
        return;
    }
    if (!mensajeText) {
        alert('Por favor, escribe un mensaje.');
        return;
    }

    // Crea un objeto FormData para enviar los datos del formulario, incluyendo los archivos.
    const formData = new FormData();
    formData.append('archivoExcel', fileInput.files[0]);
    formData.append('mensaje', mensajeText);

    // Adjunta la imagen solo si se ha seleccionado una.
    if (imagenInput.files.length > 0) {
        formData.append('archivoImagen', imagenInput.files[0]);
    }

    // Deshabilita el botón y actualiza la UI para indicar que el proceso ha comenzado.
    btn.disabled = true;
    btn.innerText = "Procesando...";
    resultadoDiv.innerHTML = "<p>Iniciando proceso...</p>";
    resultadoDiv.style.backgroundColor = "transparent";
    logsContainer.style.display = 'flex'; // Muestra los contenedores de logs.
    successLog.innerHTML = ''; // Limpia el log de éxitos.
    errorLog.innerHTML = ''; // Limpia el log de errores.
    
    try {
        // Realiza la petición POST al servidor con los datos del formulario.
        const response = await fetch('/enviar-mensajes', {
            method: 'POST',
            body: formData
        });

        // Si la respuesta del servidor no es exitosa, lanza un error.
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            let errorMessage = errorData.error || 'Error en la respuesta del servidor.';
            if (errorData.detalle) {
                errorMessage += `<br><small>Detalle: ${errorData.detalle}</small>`;
            }
            throw new Error(errorMessage);
        }

        // Procesa la respuesta del servidor como un stream de datos.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // Lee el stream hasta que se complete.
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('
');
            buffer = lines.pop(); // Guarda la línea parcial para la siguiente iteración.

            // Procesa cada línea completa recibida del stream.
            for (const line of lines) {
                if (line.trim() === '') continue;
                try {
                    const event = JSON.parse(line); // Parsea el evento JSON.
                    handleStreamEvent(event); // Maneja el evento.
                } catch (e) {
                    console.error('Error al procesar línea del stream:', line, e);
                }
            }
        }

        // Procesa cualquier dato restante en el buffer.
        if (buffer.trim() !== '') {
            try {
                const event = JSON.parse(buffer);
                handleStreamEvent(event);
            } catch (e) {
                console.error('Error al procesar el buffer final del stream:', buffer, e);
            }
        }

    } catch (error) {
        // Muestra un mensaje de error si la petición fetch falla.
        resultadoDiv.style.backgroundColor = "#f8d7da";
        resultadoDiv.innerHTML = `<strong>Error:</strong> ${error.message}`;
        console.error(error);
        btn.disabled = false;
        btn.innerText = "Enviar Mensajes";
    }
}

/**
 * Maneja los diferentes tipos de eventos recibidos del stream del servidor.
 * @param {object} event - El objeto de evento parseado desde el stream.
 */
function handleStreamEvent(event) {
    // Obtiene las referencias a los elementos del DOM.
    const resultadoDiv = document.getElementById('resultado');
    const successLog = document.getElementById('success-log');
    const errorLog = document.getElementById('error-log');
    const btn = document.getElementById('btnEnviar');

    if (event.type === 'start') {
        // Evento de inicio: muestra el número total de contactos.
        totalContactos = event.total;
        resultadoDiv.innerHTML = `<p>Iniciando envío a <strong>${totalContactos}</strong> contactos...</p>`;
    } else if (event.type === 'progress') {
        // Evento de progreso: actualiza el log con el estado de cada envío.
        const { index, nombre, numero, status, errorMsg, tiempoEspera } = event.data;
        let statusHtml = '';
        let logTarget = null; // El contenedor de log a usar (éxito o error).

        switch (status) {
            case 'enviado':
                statusHtml = '<span style="color: green;">✅ Enviado</span>';
                logTarget = successLog;
                break;
            case 'error':
                statusHtml = `<span style="color: red;">❌ Error: ${errorMsg}</span>`;
                logTarget = errorLog;
                break;
            case 'omitido':
                statusHtml = '<span style="color: orange;">⚠️ Omitido</span>';
                logTarget = errorLog; // Los omitidos también se muestran en el log de errores.
                break;
        }
        
        if (logTarget) {
            // Crea y añade la entrada de log al contenedor correspondiente.
            let progressEntry = document.createElement('div');
            progressEntry.innerHTML = `
                <div style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
                    <p style="margin: 0;">(${index}/${totalContactos}) <b>${nombre}</b> (${numero}): ${statusHtml}.</p>
                    ${tiempoEspera > 0 ? `<p style="margin: 0; font-size: 0.8em; color: #666;"><i>Esperando ${tiempoEspera}s para el próximo...</i></p>` : ''}
                </div>
            `;
            logTarget.appendChild(progressEntry);
            logTarget.scrollTop = logTarget.scrollHeight; // Auto-scroll hacia el final.
        }

    } else if (event.type === 'done') {
        // Evento de finalización: muestra el resumen del proceso.
        const { total, enviados, errores } = event.data;
        let summaryHtml = `
            <div style="padding-top: 10px;">
                <h3 style="text-align: center;">¡Proceso Completado!</h3>
                <p><strong>Resumen:</strong></p>
                <p>Total de contactos: ${total}</p>
                <p>Enviados con éxito: ${enviados}</p>
                <p>Errores / Omitidos: ${errores}</p>
            </div>
        `;
        resultadoDiv.innerHTML = summaryHtml;
        resultadoDiv.scrollTop = resultadoDiv.scrollHeight;
        
        // Rehabilita el botón y cambia el texto.
        btn.disabled = false;
        btn.innerText = "Enviar Mensajes de Nuevo";
        resultadoDiv.style.backgroundColor = "#d4edda";

    } else if (event.type === 'error') {
        // Evento de error general del proceso.
        let errorHtml = `<strong>Error:</strong> ${event.error}`;
        if (event.detalle) {
            errorHtml += `<br><small>${event.detalle}</small>`;
        }
        resultadoDiv.innerHTML = errorHtml;
        resultadoDiv.style.backgroundColor = "#f8d7da";
        btn.disabled = false;
        btn.innerText = "Enviar Mensajes";
    }
}
