// Importação de módulos necessários
const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs');
const qrcode = require('qrcode-terminal');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
require('dotenv').config();
const express = require('express');
const app = express();
const port = 3000;

// ================= TRATAMENTO DE ERROS =================
process.on('uncaughtException', (err) => {
    console.error('Erro não tratado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Promise rejeitada não tratada em:', promise, 'motivo:', reason);
});

// Inicializa o cliente do WhatsApp
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: './sessions' 
    }),
    puppeteer: {
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      }
    });

// ================= BANCO DE DADOS =================
const db = new sqlite3.Database('./boteco_caju.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Erro ao conectar ao banco de dados:', err.message);
    } else {
        console.log('Conectado ao banco de dados SQLite.');
    }
});

const atendimentos = {};
const userStates = {};
const branchStates = {};
const ultimoMenuEnviado = {};
const delay = ms => new Promise(res => setTimeout(res, ms));

// ================= CONFIGURAÇÕES =================
const RH_PHONE = ''; 
const RH_EMAIL = ''; 
const ADMIN_NUMBERS = ['@c.us'];
const BOT_NUMBER = '@c.us'; 
// ================= FUNÇÕES AUXILIARES =================
async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS contatos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                telefone TEXT UNIQUE,
                nome TEXT,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
            )`, (err) => {
                if (err) return reject(err);
                
                db.run(`CREATE TABLE IF NOT EXISTS interacoes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    telefone TEXT,
                    contato_id INTEGER,
                    mensagem TEXT,
                    remetente TEXT,
                    data DATETIME DEFAULT CURRENT_TIMESTAMP,
                    atendido BOOLEAN DEFAULT 0,
                    protocolo TEXT,
                    atendente TEXT,
                    FOREIGN KEY (contato_id) REFERENCES contatos(id)
                )`, (err) => {
                    if (err) return reject(err);
                    
                    db.run(`CREATE TABLE IF NOT EXISTS estados (
                        telefone TEXT PRIMARY KEY,
                        estado TEXT,
                        filial TEXT,
                        dados TEXT,
                        atualizado_em DATETIME DEFAULT CURRENT_TIMESTAMP
                    )`, (err) => {
                        if (err) return reject(err);
                        
                        db.run(`CREATE TABLE IF NOT EXISTS feedback (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            contato_id INTEGER,
                            tipo TEXT CHECK(tipo IN ('sugestao', 'reclamacao')),
                            texto TEXT,
                            data DATETIME DEFAULT CURRENT_TIMESTAMP,
                            FOREIGN KEY (contato_id) REFERENCES contatos(id)
                        )`, (err) => {
                            if (err) reject(err);
                            else {
                                console.log('✅ Estrutura do banco de dados verificada');
                                resolve();
                            }
                        });
                    });
                });
            });
        });
    });
}
async function clearMenuTimeout(phone) {
    if (ultimoMenuEnviado[phone]) {
        delete ultimoMenuEnviado[phone];
    }
}
async function checkActiveSupports() {
    return new Promise((resolve) => {
        db.all(
            `SELECT telefone, estado, filial FROM interacoes 
             JOIN estados ON interacoes.telefone = estados.telefone
             WHERE atendido = 1 
             AND datetime(interacoes.data) > datetime('now', '-30 days')`,
            [],
            (err, rows) => {
                if (!err && rows) {
                    rows.forEach(row => {
                        if (!atendimentos[row.telefone]) {
                            atendimentos[row.telefone] = {
                                atendenteIniciou: true,
                                protocolo: `MAN-${Date.now().toString().slice(-6)}`,
                                data: new Date(),
                                atendente: 'Sistema',
                                interacao_id: null
                            };
                            userStates[row.telefone] = row.estado;
                            if (row.filial) branchStates[row.telefone] = row.filial;
                            
                            console.log(`✅ Atendimento recuperado: ${row.telefone} (Estado: ${row.estado})`);
                        }
                    });
                }
                resolve();
            }
        );
    });
}

function getChatSafe(phone) {
    return client.getChatById(phone).catch(() => null);
}

async function simulateTyping(phone, duration = 1500) {
    try {
        const chat = await getChatSafe(phone);
        if (chat) {
            await chat.sendStateTyping();
            await delay(duration);
        }
    } catch (error) {
        console.error('Erro ao simular digitação:', error);
    }
}

async function sendWithTyping(phone, message, typingDuration = 1500) {
    // Não envia mensagens automáticas durante atendimento humano
    if (atendimentos[phone]?.atendenteIniciou && message.includes('Como posso te ajudar hoje')) {
        return;
    }
    
    try {
        const chat = await getChatSafe(phone);
        if (!chat) return;
        
        await simulateTyping(phone, typingDuration);
        await client.sendMessage(phone, message);
        await saveConversation(phone, message, true);
    } catch (error) {
        console.error('Erro ao enviar mensagem:', error);
    }
}

// ================= GERENCIAMENTO DE ESTADO UNIFICADO =================
async function saveState(phone, state, branch = null, data = null) {
    const dados = data ? JSON.stringify(data) : null;
    db.run(`INSERT OR REPLACE INTO estados (telefone, estado, filial, dados) VALUES (?, ?, ?, ?)`, 
        [phone, state, branch, dados]);
    // Atualizar também em memória
    userStates[phone] = state;
    if (branch) branchStates[phone] = branch;
}

async function loadState(phone) {
    // Verificar primeiro em memória
    if (userStates[phone]) {
        return { 
            state: userStates[phone], 
            branch: branchStates[phone], 
            data: null 
        };
    }
    
    // Se não em memória, buscar do BD
    return new Promise((resolve) => {
        db.get(`SELECT estado, filial, dados FROM estados WHERE telefone = ?`, 
            [phone], (err, row) => {
            if (err) {
                console.error('Erro ao carregar estado:', err);
                return resolve(null);
            }
            if (!row) return resolve(null);
            
            // Atualizar em memória
            userStates[phone] = row.estado;
            branchStates[phone] = row.filial;
            
            resolve({ 
                state: row.estado, 
                branch: row.filial, 
                data: row.dados ? JSON.parse(row.dados) : null 
            });
        });
    });
}

async function deleteState(phone) {
    return new Promise((resolve) => {
        db.run(`DELETE FROM estados WHERE telefone = ?`, [phone], () => {
            delete userStates[phone];
            delete branchStates[phone];
            resolve();
        });
    });
}

// ================= VALIDAÇÃO DE ADMINISTRADORES =================
function isValidAdminNumber(phone) {
    if (!phone || typeof phone !== 'string') return false;

    // Ignora números especiais e grupos
    if (phone.endsWith('@g.us') || phone.endsWith('@broadcast') || phone === 'status@broadcast') {
        return false;
    }

    // Padroniza o número
    const cleanedPhone = phone.replace(/\D/g, '');

    // Verifica se o número está na lista de administradores
    return ADMIN_NUMBERS.some(adminPhone => {
        const cleanedAdmin = adminPhone.replace(/\D/g, '');
        return cleanedAdmin === cleanedPhone;
    });
}
async function checkHumanSupport(phone) {
    return new Promise((resolve) => {
        db.get(
            `SELECT 1 FROM interacoes 
             WHERE telefone = ? 
             AND atendido = 1 
             AND datetime(data) > datetime('now', '-6 hours')`,
            [phone],
            (err, row) => {
                resolve(!!row || !!atendimentos[phone]?.atendenteIniciou);
            }
        );
    });
}

async function saveConversation(phone, message, isBot = false) {
    try {
        // Ignora mensagens de broadcast e status
        if (phone.endsWith('@broadcast') || phone === 'status@broadcast') {
            return;
        }

        const sanitizedPhone = phone.replace('@c.us', '').replace(/\D/g, '');
        const logDir = path.join(__dirname, 'chat_logs');
        
        // Garante que o diretório existe
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
        
        const logFile = path.join(logDir, `${sanitizedPhone}.txt`);
        const timestamp = new Date().toLocaleString('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        // Formata a mensagem para o log
        const logMessage = `[${timestamp}] ${isBot ? 'BOT' : 'USER'}: ${message}\n`;
        
        // Escreve no arquivo de log
        fs.appendFileSync(logFile, logMessage, { flag: 'a' });

        // Obtém ou cria o contato
        const contact = await client.getContactById(phone).catch(() => null);
        const name = contact?.pushname || 'Não informado';
        const contatoId = await saveUser(phone, name);

        // Salva a interação no banco de dados
        db.run(
            `INSERT INTO interacoes (telefone, contato_id, mensagem, remetente, atendido, protocolo, atendente) 
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                phone,
                contatoId,
                message,
                isBot ? 'BOT' : 'USER',
                atendimentos[phone] ? 1 : 0,
                atendimentos[phone]?.protocolo || null,
                atendimentos[phone]?.atendente || null
            ],
            function(err) {
                if (err) {
                    console.error('Erro ao salvar interação no banco:', err);
                }
            }
        );

    } catch (error) {
        console.error('Erro ao salvar conversa:', {
            error: error.message,
            stack: error.stack,
            phone,
            message
        });
    }
}

async function saveUser (phone, name = 'Não informado') {
    // Verifica se phone é uma string
    if (typeof phone !== 'string') {
        console.error('Número de telefone inválido:', phone);
        return; // Retorna ou lança um erro apropriado
    }
    
    const cleanPhone = phone.replace('@c.us', '');
    
    return new Promise((resolve, reject) => {
        db.get(`SELECT id FROM contatos WHERE telefone = ?`, [cleanPhone], (err, row) => {
            if (err) return reject(err);
            
            if (row) {
                // Atualiza o nome se necessário
                db.run(`UPDATE contatos SET nome = ? WHERE telefone = ?`, 
                      [name, cleanPhone], function() {
                    resolve(row.id);
                });
            } else {
                // Insere novo contato
                db.run(`INSERT INTO contatos (telefone, nome) VALUES (?, ?)`, 
                      [cleanPhone, name], function(err) {
                    if (err) reject(err);
                    else resolve(this.lastID);
                });
            }
        });
    });
}

// ================= ATENDIMENTO =================
async function endSupport(targetPhone, adminPhone = null) {
    try {
        if (!atendimentos[targetPhone]) return false;

        // Remove do banco de dados
        await new Promise((resolve) => {
            db.run(
                `UPDATE interacoes 
                 SET atendido = 0 
                 WHERE telefone = ? 
                 AND atendido = 1`,
                [targetPhone],
                (err) => {
                    if (err) {
                        console.error('Erro ao encerrar atendimento:', err);
                        return resolve(false);
                    }
                    resolve(true);
                }
            );
        });

        // Remove completamente o estado do usuário
        delete atendimentos[targetPhone];
        delete userStates[targetPhone];
        delete branchStates[targetPhone];
        await deleteState(targetPhone);

        // Notificação
        if (adminPhone) {
            await client.sendMessage(
                adminPhone, 
                `✅ Atendimento encerrado para ${targetPhone}`
            );
        }
        return true;
    } catch (error) {
        console.error('Erro ao encerrar atendimento:', error);
        return false;
    }
}

async function requestHumanSupport(msg) {
    clearMenuTimeout(msg.from);
    
    // Verifica se já existe um atendimento ativo
    if (atendimentos[msg.from]) {
        await sendWithTyping(msg.from, 
            `🔔 Você já tem um atendimento em andamento com protocolo ${atendimentos[msg.from].protocolo}`);
        return;
    }

    const protocolo = `AT${Date.now().toString().slice(-6)}`;
    const tempoEstimado = "10-15 minutos";
    
    const contact = await client.getContactById(msg.from).catch(() => null);
    const name = contact?.pushname || 'Cliente';
    await saveUser(msg.from, name);

    // Registra o atendimento
    atendimentos[msg.from] = {
        atendenteIniciou: false,
        protocolo: protocolo,
        data: new Date(),
        atendente: 'Sistema'
    };

    // Salva no banco de dados
    db.run(
        `INSERT INTO interacoes (telefone, mensagem, remetente, atendido, protocolo) 
        VALUES (?, ?, ?, 1, ?)`,
        [msg.from, msg.body, 'USER', protocolo]
    );

    // Envia mensagem para o cliente
    await sendWithTyping(msg.from, 
        `🔔 *ATENDIMENTO HUMANITO SOLICITADO* 🔔\n\n` +
        `📌 Protocolo: ${protocolo}\n` +
        `⏳ Tempo estimado: ${tempoEstimado}\n\n` +
        `Aguarde enquanto nossos atendentes são notificados.`);

    // Notifica administradores
    for (const admin of ADMIN_NUMBERS) {
        await delay(1000);
        if (isValidAdminNumber(admin)) {
            const numeroCliente = msg.from.replace('@c.us', '');
            const contact = await client.getContactById(msg.from).catch(() => null);
            const nomeCliente = contact?.pushname || 'Cliente';
            
            await client.sendMessage(
                admin,
                `⚠️ *NOVO ATENDIMENTO SOLICITADO*\n\n` +
                `👤 Cliente: ${nomeCliente}\n` +
                `📞 Número: ${numeroCliente}\n` +
                `📋 Protocolo: ${protocolo}\n` +
                `⏰ ${new Date().toLocaleString('pt-BR')}\n\n` +
                `Envie uma mensagem diretamente para ${numeroCliente} para iniciar o atendimento.`,
                { sendSeen: false }
            );
        }
    }
}

// ================= COMANDOS ADMIN =================
async function handleAdminCommands(msg) {
    const phone = msg.from;
    if (!isValidAdminNumber(phone)) {
        return false;
    }
    
    const isToBot = msg.to === BOT_NUMBER || phone === BOT_NUMBER;
    if (!isToBot) return false;

    const command = msg.body.split(' ')[0].toLowerCase();
    const targetPhone = msg.body.split(' ')[1] ? msg.body.split(' ')[1] + '@c.us' : null;

    if (msg.body.toLowerCase() === 'meus atendimentos') {
        const meusAtendimentos = Object.entries(atendimentos)
            .filter(([_, info]) => info.atendente === msg.from)
            .map(([phone, info]) => `${phone} (desde ${info.data.toLocaleTimeString()})`)
            .join('\n');
        
        await sendWithTyping(null, msg.from, 
            `📋 Seus atendimentos ativos:\n${meusAtendimentos || 'Nenhum'}`);
        return true;
    }

    switch(command) {
        case '/atender':
            if (!targetPhone) {
                await sendWithTyping(null, phone, '⚠️ Uso correto: /atender 61912345678');
                return true;
            }
            atendimentos[targetPhone] = { 
                atendenteIniciou: true,
                protocolo: `MAN-${Date.now().toString().slice(-6)}`,
                data: new Date(),
                atendente: phone,
                isManual: true
            };
            db.run(`UPDATE interacoes SET atendido = 1, atendente = ? WHERE telefone = ?`, [phone, targetPhone]);
            await sendWithTyping(null, phone, `✅ Você assumiu o atendimento de ${targetPhone}`);
            return true;

        case '/status':
            if (targetPhone) {
                const status = atendimentos[targetPhone] 
                    ? `Em atendimento (desde ${atendimentos[targetPhone].data.toLocaleString('pt-BR')})`
                    : 'Em modo automático';
                await sendWithTyping(null, phone, `Status ${targetPhone}: ${status}`);
            } else {
                const activeSupports = Object.entries(atendimentos)
                    .filter(([_, info]) => info.atendenteIniciou)
                    .map(([phone, info]) => 
                        `📞 ${phone}\n⏰ Desde: ${info.data.toLocaleString('pt-BR')}\n👤 Atendente: ${info.atendente}`
                    );
                
                if (activeSupports.length > 0) {
                    await sendWithTyping(null, phone, 
                        `📊 *Atendimentos em andamento:*\n\n${activeSupports.join('\n\n')}`);
                } else {
                    await sendWithTyping(null, phone, 'ℹ️ Nenhum atendimento humano em andamento');
                }
            }
            return true;

            case '/encerrar':
                if (!targetPhone) {
                    await sendWithTyping(phone, '⚠️ Uso correto: /encerrar ');
                    return true;
                }
                const targetPhoneWithSuffix = targetPhone.includes('@c.us') ? targetPhone : `${targetPhone}@c.us`;
                if (await endSupport(targetPhoneWithSuffix, msg.from)) {
                    await sendWithTyping(phone, `✅ Atendimento encerrado para ${targetPhone}`);
                } else {
                    await sendWithTyping(phone, '⚠️ Não foi possível encerrar o atendimento');
                }
                return true;
    }
}

// ================= MENUS E FLUXOS DE CONVERSA =================
async function showMainMenu(phone) {
    // Verifica se phone é uma string válida
    if (typeof phone !== 'string' || !phone.endsWith('@c.us')) {
        console.error('Número de telefone inválido no menu principal:', phone);
        return;
    }

    // Verifica timeout do menu (2 minutos)
    if (ultimoMenuEnviado[phone] && (Date.now() - ultimoMenuEnviado[phone] < 120000)) {
        return;
    }
    ultimoMenuEnviado[phone] = Date.now();

    try {
        // Obtém informações do contato
        const contact = await client.getContactById(phone).catch(() => null);
        const name = contact?.pushname || 'Cliente';
        
        // Salva/atualiza o usuário no banco de dados
        await saveUser(phone, name);
        
        // Atualiza o estado para menu principal
        await saveState(phone, 'main_menu');
        
        // Remove branch se existir (para garantir fresh start)
        if (branchStates[phone]) {
            delete branchStates[phone];
        }

        // Simula digitação
        await simulateTyping(phone, 2000);
        
        // Constrói mensagem do menu
        const menuMessage = `🍹 *Olá, ${name}!* Que bom te ver aqui! 🌟\n` +
            `Eu sou o assistente virtual do * \n\n` +
            `Para começar, escolha sua unidade preferida:\n\n` +
            `1️⃣ - \n` +
            `2️⃣ - \n\n` +
            `Digite o número da opção desejada 😊\n\n` +
            `Ou digite *sair* para encerrar a conversa.`;

        // Envia a mensagem e salva no histórico
        await client.sendMessage(phone, menuMessage);
        await saveConversation(phone, menuMessage, true);

        // Log para depuração
        console.log(`Menu principal enviado para ${phone} (${name})`);

    } catch (error) {
        console.error('Erro ao mostrar menu principal:', {
            error: error.message,
            phone: phone,
            stack: error.stack
        });
        
        // Tenta enviar mensagem de erro se não estiver em atendimento humano
        if (!atendimentos[phone]?.atendenteIniciou) {
            await client.sendMessage(phone, '⚠️ Ocorreu um erro ao carregar o menu. Por favor, tente novamente.')
                .catch(e => console.error('Erro ao enviar mensagem de erro:', e));
        }
    }
}

async function showBranchMenu(msg, branch) {
    try {
        const phone = msg.from;
        branchStates[phone] = branch;
        const contact = await client.getContactById(phone).catch(() => null);
        const name = contact?.pushname || 'Cliente';

        db.run(`INSERT OR REPLACE INTO estados (telefone, estado, filial) VALUES (?, ?, ?)`, 
            [phone, 'branch_menu', branch]);

        await simulateTyping(phone, 1500);

    const menuMessage = `🍋 *Olá, ${name}!*🌿\n\n` +
    `Como posso te ajudar hoje?\n\n` +
    `1️⃣ - Horário de Funcionamento\n` +
    `2️⃣ - Ver Cardápio\n` +
    `3️⃣ - Fazer Reserva\n` +
    `4️⃣ - Benefícios Aniversariantes\n` +
    `5️⃣ - Sugestões/Reclamações\n` +
    `6️⃣ - Falar com Atendente\n` +
    `7️⃣ - Trabalhe Conosco\n` +
    `8️⃣ - Formas de Pagamento\n\n` +
    `💠 *Comandos especiais:*\n` +
    `• Digite *menu* para ver este menu novamente\n` +
    `• Digite *unidade* para trocar de unidade a qualquer momento.\n` +
    `• Digite *sair* para encerrar a conversa`;

    await sendWithTyping(phone, menuMessage);
} catch (error) {
    console.error('Erro ao mostrar menu da filial:', error);
}
}

// ================= HANDLER PRINCIPAL DE MENSAGENS =================
client.on('message', async msg => {
    try {
        // Bloqueia mensagens em grupos
        if (msg.from.endsWith('@g.us') || msg.to.endsWith('@g.us')) return;
        if (msg.from === BOT_NUMBER) return;
        const phone = msg.from.endsWith('@c.us') ? msg.from : msg.to;
        const isFromAdmin = ADMIN_NUMBERS.includes(msg.from);

        // Carrega estado do usuário se não estiver em memória
        if (!userStates[phone]) {
            const savedState = await loadState(phone);
            if (savedState) {
                userStates[phone] = savedState.state;
                branchStates[phone] = savedState.branch;
            }
        }

        // Verificação de atendimento manual (admin conversando diretamente com usuário)
        if (isFromAdmin && msg.to.endsWith('@c.us')) {
            await handleAdminDirectMessage(msg);
            return;
        }

        // Se o cliente está em atendimento e não é admin, bloqueia respostas automáticas
        if (atendimentos[phone] && !isFromAdmin) {
            // Permite apenas comandos específicos
            const allowedCommands = ['sair', 'menu', 'unidade'];
            if (!allowedCommands.includes(msg.body.toLowerCase())) {
                return;
            }
        }

        // Adicione esta verificação antes de mostrar menus automáticos
        if (!isFromAdmin && atendimentos[phone] && !msg.body.toLowerCase().match(/^(menu|sair|unidade)$/)) {
            return;
        }
        // Bloqueia mensagens do cliente durante atendimento humano
        if (atendimentos[phone]?.atendenteIniciou) {
            return;
        }

        // Salva a conversa para usuários não-administradores
        if (!isFromAdmin) {
            await saveConversation(phone, msg.body, false);
        }

        // Novo cliente sem estado - mostra menu principal
        if (!isFromAdmin && !userStates[phone] && !atendimentos[phone]) {
            await showMainMenu(phone);
            return;
        }

        // Processa comandos de administrador
        if (await handleAdminCommands(msg)) return;

        // Comando especial para encerrar atendimento
        if (isFromAdmin && msg.body.toLowerCase() === 'atendimento encerrado') {
            await endSupport(msg.to, msg.from);
            return;
        }

        // Obtém estado atual e branch
        const currentState = userStates[phone];
        const branch = branchStates[phone];
        const command = msg.body.toLowerCase().trim();

        // Processa estados especiais primeiro
        if (await handleSpecialStates(msg, currentState, branch)) {
            return;
        }

        // Comandos especiais globais
        if (await handleGlobalCommands(msg, command, branch)) {
            return;
        }

        // Fluxo principal de atendimento
        if (branch) {
            if (currentState === 'branch_menu') {
                await handleBranchMenuSelection(msg, branch);
                return;
            }
            // Mostra menu da filial se não estiver em um estado específico
            await showBranchMenu(msg, branch);
            return;
        }

        // Seleção de filial
        if (!branch) {
            if (msg.body === '1') {
                branchStates[phone] = '';
                await saveState(phone, 'branch_menu', '');
                await showBranchMenu(msg, '');
                return;
            }
            if (msg.body === '2') {
                branchStates[phone] = '';
                await saveState(phone, 'branch_menu', '');
                await showBranchMenu(msg, '');
                return;
            }
        }

    } catch (error) {
        console.error('Erro no processamento:', error);
        if (!atendimentos[msg.from]) {
            const chat = await client.getChatById(msg.from).catch(() => null);
            if (chat) {
                await sendWithTyping(msg.from, '⚠️ Ocorreu um erro inesperado. Por favor, tente novamente mais tarde.');
            }
        }
    }
});

// ================= FUNÇÕES AUXILIARES PARA O HANDLER =================

async function handleAdminDirectMessage(msg) {
    const targetPhone = msg.to;
    
    if (!atendimentos[targetPhone]) {
        // Cria o registro de atendimento
        atendimentos[targetPhone] = {
            atendenteIniciou: true,
            protocolo: `MAN-${Date.now().toString().slice(-6)}`,
            data: new Date(),
            atendente: msg.from,
            interacao_id: null
        };
        
        // Remove qualquer estado anterior
        delete userStates[targetPhone];
        delete branchStates[targetPhone];
        await deleteState(targetPhone);

        // Salva no banco de dados
        const contact = await client.getContactById(targetPhone).catch(() => null);
        const name = contact?.pushname || 'Cliente';
        const contatoId = await saveUser(targetPhone, name);
        
        db.run(
            `INSERT INTO interacoes (telefone, contato_id, mensagem, remetente, atendido, protocolo, atendente) 
            VALUES (?, ?, ?, ?, 1, ?, ?)`,
            [targetPhone, contatoId, msg.body, 'USER', atendimentos[targetPhone].protocolo, msg.from],
            function(err) {
                if (!err) atendimentos[targetPhone].interacao_id = this.lastID;
            }
        );

        // Envia confirmação para o admin
        await client.sendMessage(
            msg.from,
            `✅ Você iniciou um atendimento com ${targetPhone}\n` +
            `📋 Protocolo: ${atendimentos[targetPhone].protocolo}`
        );
    }
    
    // Bloqueia respostas automáticas do bot
    ultimoMenuEnviado[targetPhone] = Date.now();
}

async function handleSpecialStates(msg, currentState, branch) {
    const phone = msg.from;
    
    // Estado de feedback
    if (currentState === 'awaiting_feedback_type') {
        if (msg.body === '1') {
            userStates[phone] = 'awaiting_feedback_text_suggestion';
            await saveState(phone, 'awaiting_feedback_text_suggestion', branch);
            await sendWithTyping(phone, 
                `📝 *${name}, vamos registrar sua sugestão!* 💡\n` +
                `Por favor, envie sua sugestão em *uma única mensagem de texto*. Assim podemos encaminhar corretamente para nossa equipe.\n` +
                `Sua opinião é muito valiosa para nós! ✨`);
            return true;
        }
        if (msg.body === '2') {
            userStates[phone] = 'awaiting_feedback_text_complaint';
            await saveState(phone, 'awaiting_feedback_text_complaint', branch);
            await sendWithTyping(phone, 
                `📝 *${name}, vamos resolver isso juntos!* 🤝\n\n` +
                `Por favor, descreva o ocorrido em *uma única mensagem de texto*, incluindo todos os detalhes importantes.\n\n` +
                `• O que aconteceu\n` +
                `• Como podemos melhorar\n\n` +
                `Nossa equipe analisará com atenção e entrará em contato se necessário.💚`);
            return true;
        }
        if (msg.body === '3') {
            await deleteState(phone);
            await showBranchMenu(msg, branch);
            return true;
        }
    }

    // Estado de texto de feedback
    if (currentState === 'awaiting_feedback_text_suggestion' || 
        currentState === 'awaiting_feedback_text_complaint') {
        
        const contact = await client.getContactById(phone).catch(() => null);
        const name = contact?.pushname || 'Cliente';
        const contatoId = await saveUser(phone.replace('@c.us', ''), name);
        const tipo = currentState.includes('suggestion') ? 'sugestao' : 'reclamacao';
        
        db.run(
            `INSERT INTO feedback (contato_id, tipo, texto) 
            VALUES (?, ?, ?)`,
            [contatoId, tipo, msg.body],
            (err) => {
                if (err) console.error('Erro ao salvar feedback:', err);
            }
        );
        
        await sendWithTyping(phone, 
            `🌸 *Muito obrigado, ${name}!* 💚\n\n` +
            `Sua ${tipo === 'sugestao' ? 'sugestão' : 'reclamação'} foi registrada com o protocolo #${protocolo.slice(-4)}.\n\n` +
            `${tipo === 'sugestao' ? 'Valorizamos muito sua contribuição para melhorarmos!' : 'Nossa equipe já está analisando seu caso e entrará em contato se necessário.'}\n\n` +
            `Volte sempre ao *Caju Limão*! 🍋\n\nvoltando ao menu...`);
        await deleteState(phone);
        await showBranchMenu(msg, branch);
        return true;
    }
    
    return false;
}

async function handleGlobalCommands(msg, command, branch) {
    const phone = msg.from;
    
    if (command === 'menu') {
        await showBranchMenu(msg, branch);
        return true;
    } 
    if (command === 'unidade') {
        clearMenuTimeout(phone); 
        delete branchStates[phone];
        await deleteState(phone);
        await showMainMenu(phone);
        return true;
    }
    if (command === 'sair') {
        clearMenuTimeout(phone); 
        await sendWithTyping(phone, 
            `🌟 *Até logo, ${name}!* Foi um prazer te ajudar! 🍋\n\n` +
            `Se precisar de mais alguma coisa, é só chamar. Estamos à disposição!\n\n` +
            `Volte sempre ao **! 💚\n` +
            `Tenha um ótimo dia! 😊`);
        await deleteState(phone);
        return true;
    }
    
    return false;
}

async function handleBranchMenuSelection(msg, branch) {
    const phone = msg.from;
    const option = msg.body.trim();
    
    switch(option) {
        case '1':
            await simulateTyping(phone, 1000);
            const horario = `⏰ *Horário de Funcionamento* 🍋\n\n` +
                `🟢\n` +
                `🟢 \n` +
                `🟢\n\n` +
                `**\n\n` +
                `Feriados: funcionamento normal!`;
            await sendWithTyping(phone, horario);
            break;
            
        case '2':
            await simulateTyping(phone, 800);
            const cardapio = ``;
            await sendWithTyping(phone, cardapio);
            break;
            
            case '3':
                await simulateTyping(phone, 1500);
                const linkReserva = branch === '' 
                
                const nomeUnidade = branch === '' ? ' ' : '';
                const contact = await client.getContactById(phone).catch(() => null);
                const name = contact?.pushname || 'Cliente';
            
                const reserva = `📅 *Reserva - ${nomeUnidade}* 🍋\n\n` +
                    `Olá, ${name}! Para garantir sua experiência no * ${nomeUnidade}*:\n\n` +
                    `1️⃣ *Reserve pelo link:*\n` +
                    `🔗 ${linkReserva}\n\n` +
                    `2️⃣ *Informações úteis:*\n` +
                    `• Mesas limitadas - garanta já a sua!\n\n` +
                    `💡 Precisa de ajuda com a reserva ou prefere ser atendido por um atendente?\n` +
                    `Digite *6* e nosso time entrará em contato com você! 💚\n\n` +
                    `Estamos ansiosos para recebê-lo(a) no Caju Limão!`;
            
                await sendWithTyping(phone, reserva);
                break;
        case '4':
            await simulateTyping(phone, 1200);
            const aniversario = `🎉 *Benefícios para Aniversariantes* 🍋\n\n` +
                `📅 Válido na semana do aniversário\n\n` +
                `Mais informações: digite *6* para falar com nosso atendente`;
            await sendWithTyping(phone, aniversario);
            break;
            
        case '5':
            await simulateTyping(phone, 1000);
            const feedbackMenu = `📢 *Feedback* 🍋\n\n` +
                    `1️⃣ Para deixar uma sugestão\n` +
                    `2️⃣ Para fazer uma reclamação\n` +
                    `3️⃣ Voltar ao menu anterior`
            await sendWithTyping(phone, feedbackMenu);
            userStates[phone] = 'awaiting_feedback_type';
            await saveState(phone, 'awaiting_feedback_type', branch);
            break;
            
        case '6':
            await requestHumanSupport(msg);
            break;
            
        case '7':
            await simulateTyping(phone, 1200);
            const trabalhoMsg = `🌟 *Trabalhe no !* 🌿\n\n` +
                `Ficamos felizes pelo seu interesse em fazer parte do nosso time!\n\n` +
                `📞 *Contato do RH:* ${RH_PHONE}\n` +
                `📧 *Envie seu currículo para:* ${RH_EMAIL}\n\n` +
                `Nós analisaremos seu currículo com carinho e entraremos em contato ` +
                `caso surjam oportunidades compatíveis com seu perfil.\n\n` +
                `Agradecemos seu interesse! 💚`;
            await sendWithTyping(phone, trabalhoMsg);
            break;
            
        case '8':
            await simulateTyping(phone, 1800);
            const pagamentosMsg = `💳 *Formas de Pagamento Aceitas* 🌿\n\n` +
            await sendWithTyping(phone, pagamentosMsg);
            break;
            
        default:
            // Se não for uma opção válida, mostra o menu novamente
            await showBranchMenu(msg, branch);
    }
}

// ================= INTERFACE WEB =================
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/atendimentos', (req, res) => {
    db.all(`
        SELECT telefone, MAX(protocolo) as protocolo, MAX(data) as data, 
               MAX(atendente) as atendente, 1 as atendido
        FROM interacoes 
        WHERE atendido = 1 
        GROUP BY telefone
        HAVING datetime(MAX(data)) > datetime('now', '-3 hours')
        ORDER BY data DESC
    `, [], (err, rows) => {
        if (err) return res.status(500).send('Erro no banco de dados');
        const atendimentosHTML = rows.map(row => `
            <tr>
                <td>${row.telefone.replace('@c.us', '')}</td>
                <td>${row.protocolo || 'N/A'}</td>
                <td>${row.data}</td>
                <td>${row.atendido ? 'Atendido' : 'Não Atendido'}</td>
                <td>${row.atendente || 'Sistema'}</td>
                <td>
                    <form action="/encerrar" method="POST" style="margin: 0;">
                        <input type="hidden" name="telefone" value="${row.telefone}">
                        <button type="submit" class="btn btn-danger btn-sm">Encerrar Atendimento</button>
                    </form>
                </td>
            </tr>
        `).join('');

        const html = `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
                <title>Atendimentos Ativos</title>
            </head>
            <body>
                <div class="container mt-4">
                    <h2 class="mb-4">Atendimentos Ativos</h2>
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead class="table-light">
                                <tr>
                                    <th>Número</th>
                                    <th>Protocolo</th>
                                    <th>Data/Hora</th>
                                    <th>Status</th>
                                    <th>Atendente</th>
                                    <th>Ação</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${atendimentosHTML}
                            </tbody>
                        </table>
                    </div>
                </div>
            </body>
            </html>
        `;
        res.send(html);
    }); 
});
// ================= ROTA PARA FEEDBACK =================
app.get('/feedback', (req, res) => {
    db.all(`
        SELECT 
            f.id,
            f.tipo,
            f.texto,
            strftime('%d/%m/%Y %H:%M', f.data) as data_formatada,
            c.telefone,
            c.nome,
            (SELECT mensagem FROM interacoes 
             WHERE telefone = c.telefone 
             AND remetente = 'USER'
             ORDER BY data DESC 
             LIMIT 1) as ultima_mensagem
        FROM feedback f
        JOIN contatos c ON f.contato_id = c.id
        ORDER BY f.data DESC
    `, [], (err, rows) => { 
        if (err) return res.status(500).send('Erro no banco de dados');

        const feedbackHTML = rows.map(row => `
            <tr class="feedback-item" data-tipo="${row.tipo}">
                <td>${row.nome || 'Anônimo'}</td>
                <td>${row.telefone.replace('@c.us', '')}</td>
                <td>${row.tipo === 'sugestao' ? '✅ Sugestão' : '⚠️ Reclamação'}</td>
                <td>${row.texto}</td>
                <td>${row.data_formatada}</td>
                <td>${row.ultima_mensagem || 'N/A'}</td>
            </tr>
        `).join('');

        const html = `
            <!DOCTYPE html>
            <html lang="pt-BR">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
                <title>Feedback dos Clientes</title>
            </head>
            <body>
                <div class="container mt-4">
                    <h2 class="mb-4">Feedback dos Clientes</h2>
                    <div class="table-responsive">
                        <table class="table table-hover">
                            <thead class="table-light">
                                <tr>
                                    <th>Nome</th>
                                    <th>Telefone</th>
                                    <th>Tipo</th>
                                    <th>Feedback</th>
                                    <th>Data/Hora</th>
                                    <th>Contexto</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${feedbackHTML}
                            </tbody>
                        </table>
                    </div>
                </div>
            </body>
            </html>
        `;
        res.send(html);
    });
});

// ================= PÁGINA INICIAL ATUALIZADA =================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
            <title>Painel de Controle</title>
        </head>
        <body>
            <div class="container mt-5">
                <h1 class="mb-4">Painel de Controle do Chatbot</h1>
                <div class="list-group">
                    <a href="/atendimentos" class="list-group-item list-group-item-action">
                        📋 Ver Atendimentos Ativos
                    </a>
                    <a href="/feedback" class="list-group-item list-group-item-action">
                        📢 Ver Feedback dos Clientes
                    </a>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.post('/encerrar', (req, res) => {
    const telefone = req.body.telefone;

    // Primeiro verifica se existe um atendimento ativo
    db.get(`SELECT 1 FROM interacoes WHERE telefone = ? AND atendido = 1 LIMIT 1`, [telefone], (err, row) => {
        if (err || !row) {
            return res.status(404).send('Atendimento não encontrado ou já encerrado');
        }

        // Atualiza o status e registra o encerramento
        db.run(`UPDATE interacoes SET atendido = 0 WHERE telefone = ?`, [telefone], (err) => {
            if (err) {
                console.error('Erro ao encerrar atendimento:', err);
                return res.status(500).send('Erro ao encerrar atendimento');
            }

            // Remove da memória se existir
            if (atendimentos[telefone]) {
                delete atendimentos[telefone];
            }

            res.redirect('/atendimentos');
        });
    });
});

app.listen(port, () => console.log(`🌐 Interface web em http://localhost:${port}`));

// ================= INICIALIZAÇÃO =================
client.on('ready', async () => {
    console.log('✅ Bot pronto para atendimento!');
    
    // Carrega atendimentos ativos do banco de dados
    await checkActiveSupports();
    
    // Carrega todos os estados persistentes do banco de dados
    await loadAllPersistentStates();
    
    console.log(`🔄 Estados carregados: ${Object.keys(userStates).length} usuários com estado`);
});
async function loadAllPersistentStates() {
    return new Promise((resolve) => {
        db.all(`SELECT telefone, estado, filial, dados FROM estados`, [], (err, rows) => {
            if (err) {
                console.error('Erro ao carregar estados:', err);
                return resolve();
            }
            
            rows.forEach(row => {
                userStates[row.telefone] = row.estado;
                if (row.filial) branchStates[row.telefone] = row.filial;
                // Você pode adicionar tratamento para dados adicionais se necessário
            });
            
            resolve();
        });
    });
}
client.on('disconnected', (reason) => {
    console.log('⚠️ Conexão perdida:', reason);
    console.log('🔄 Reconectando...');
    setTimeout(() => client.initialize(), 5000);
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('Escaneie o QR Code acima para conectar');
});

async function startBot() {
    try {
        console.log('🛠️ Inicializando banco de dados...');
        await initializeDatabase();
        await checkActiveSupports();
        console.log('✅ Banco de dados pronto');

        console.log('🛠️ Inicializando cliente WhatsApp...');

        await client.initialize();
        client.on('auth_failure', msg => {
            console.error('❌ Falha na autenticação:', msg);
            fs.rmSync('./sessions/session', { recursive: true, force: true });
            setTimeout(startBot, 10000);
        });

        await client.initialize();
    } catch (error) {
        console.error('Falha crítica na inicialização:', {
            error: error.message,
            stack: error.stack
        });
        
        // Força a limpeza da sessão
        try {
            fs.rmSync('./sessions/session', { recursive: true, force: true });
        } catch (e) {
            console.log('⚠️ Não foi possível limpar a sessão:', e.message);
        }
        
        console.log('🔄 Tentando novamente em 10 segundos...');
        setTimeout(startBot, 10000);
    }
}

startBot().catch(console.error);