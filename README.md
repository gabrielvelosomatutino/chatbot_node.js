***Chatbot de Atendimento para WhatsApp***

**Introdução**

Este projeto consiste em um chatbot multifuncional para WhatsApp, desenvolvido para automatizar e otimizar o atendimento ao cliente. A solução é projetada para ser flexível, atendendo múltiplos estabelecimentos ou filiais, e oferecendo um fluxo de conversa intuitivo para os usuários, ao mesmo tempo que provê um painel de controle e comandos administrativos para uma gestão eficiente dos atendimentos.

**Persistência de Dados**

O chatbot utiliza um banco de dados SQLite para armazenar de forma persistente todas as informações relevantes para a operação. As tabelas incluem:

Contatos: Armazena informações dos usuários que interagiram com o bot.

Interações: Registra todo o histórico de conversas, incluindo mensagens de usuários, respostas do bot e atendimentos humanos.

Estados: Gerencia o estado atual de cada usuário no fluxo de conversa, permitindo que a interação seja retomada de onde parou.

Feedback: Guarda sugestões e reclamações enviadas pelos clientes para análise posterior.

Além do banco de dados, os logs de conversa de cada usuário são salvos em arquivos de texto (.txt) para fins de depuração e auditoria.

**Tecnologias Utilizadas**

O projeto foi desenvolvido em Node.js e utiliza um conjunto de bibliotecas robustas para garantir seu funcionamento:

whatsapp-web.js: Biblioteca principal que permite a interação com o WhatsApp Web, automatizando o envio e recebimento de mensagens.

sqlite3: Driver para a gestão do banco de dados SQLite, onde os dados são persistidos.

express: Framework web utilizado para criar um painel de controle acessível via navegador, que exibe atendimentos ativos e feedback dos clientes.

qrcode-terminal: Gera o QR Code de autenticação diretamente no terminal, facilitando a conexão inicial com o WhatsApp.

dotenv: Para gerenciamento de variáveis de ambiente de forma segura.

**Funcionalidades Principais**

Os principais objetivos e funcionalidades deste chatbot são:

Fluxo de Atendimento por Filiais: O bot inicialmente pergunta ao cliente qual unidade ele deseja atendimento, direcionando-o para menus e informações específicas daquela localidade.

Menus Interativos: Apresenta opções claras aos usuários, como consulta de horário, cardápio, reservas, benefícios, formas de pagamento, e mais.

Solicitação de Atendimento Humano: Permite que o cliente solicite a intervenção de um atendente a qualquer momento, notificando os administradores sobre o novo pedido.

Coleta de Feedback: Possui um módulo específico para que os clientes possam enviar sugestões e reclamações de forma estruturada.

Painel de Controle Web: Oferece uma interface web simples para administradores visualizarem os atendimentos em andamento, o histórico de feedback e encerrarem conversas que já foram finalizadas.

Comandos Administrativos: Administradores podem interagir diretamente com o bot para assumir, verificar o status ou encerrar atendimentos manualmente.

**Resultados e Conclusões**

A implementação deste chatbot proporciona uma ferramenta poderosa para a automação do atendimento ao cliente. Ele centraliza as solicitações, oferece respostas instantâneas para as dúvidas mais comuns e organiza a transição para o atendimento humano de forma eficiente. Com isso, a empresa pode otimizar seus recursos, melhorar a qualidade e a agilidade do serviço prestado e coletar dados valiosos para aprimorar continuamente suas operações.

Conclui-se que o chatbot é uma solução escalável e essencial para modernizar a comunicação com o cliente, gerando benefícios tanto para a empresa, ao reduzir a carga de trabalho manual, quanto para os clientes, que recebem um atendimento rápido e disponível 24/7.

**Como Utilizar Este Repositório**

Este repositório contém o código-fonte completo do chatbot. Para executá-lo em sua máquina, siga os passos abaixo:

**Clone o repositório:**

git clone https://github.com/seu-usuario/seu-repositorio.git
cd seu-repositorio

**Instale as dependências:**

npm install

**Configure as variáveis de ambiente:**

Crie um arquivo chamado .env na raiz do projeto.

Adicione as variáveis necessárias, como RH_PHONE, RH_EMAIL, ADMIN_NUMBERS, e BOT_NUMBER, com base no código.

**Execute o bot:**

node chatbot.js

**Autenticação:**

Um QR Code será exibido no terminal.

Abra o WhatsApp em seu celular, vá em "Aparelhos conectados" e escaneie o código para iniciar a sessão.

**Acesse o painel web:**

Abra seu navegador e acesse http://localhost:3000 para visualizar o painel de controle.

**Contribuições**

Contribuições para a melhoria deste projeto são bem-vindas. Sinta-se à vontade para enviar pull requests com correções de bugs, sugestões de novas funcionalidades ou melhorias na documentação.

**Contato**

Para mais informações ou dúvidas relacionadas a este projeto, entre em contato com [Gabriel Veloso] via e-mail: [velosogabriel5@gmail.com].
