# Inventário e Gestão de Ativos (IGA) — instruções para agentes

Este repositório é **um módulo destacado da intranet da Polícia Municipal de Lisboa**, não um
projecto autónomo. A casa a sério do código é o repositório da intranet; aqui está só o
inventário de equipamento, com o mínimo à volta para arrancar. É o mesmo molde do `correspondencia-pm`
(`C:\Apps\CorrespondenciaDEV\correspondencia-pm`) — quando houver dúvida sobre convenções, é lá
que se vai ver.

O `README.md` explica como montar e correr. Este ficheiro tem **apenas os gotchas** — o que não
se descobre a ler o código, e o que já correu mal antes.

## O nome

**IGA** é o nome curto da aplicação e é o que está no código: `server/routes/iga/`,
`/api/iga/<tipo>`, `public/iga/`, grupos `IGA`, `IGA-Consulta` e `IGA-Admin`, `req.igaUser`,
código de erro `IGA_SEM_ACESSO`. Nos ecrãs aparece o nome por extenso — "Inventário e Gestão
de Ativos" — com a sigla ao lado; só o separador do browser leva `· IGA`, que é o que lá cabe.

**Os nomes por tipo de equipamento não levam o prefixo**: `radios`, `telemoveis`, as páginas,
as tabelas (`radios_*`, `telemoveis_*`) e as bases pertencem ao tipo, não à aplicação. Um tipo
novo entra com o seu nome, não com `iga_qualquer_coisa`.

## O que não se altera aqui

- **`db.js` e `server/logger.js` são cópias inalteradas da intranet.** Se precisarem de mudar, é
  conversa para lá, não para este repositório.
- **`migrations/000_seed_local.sql` só existe neste repositório.** É andaime de desenvolvimento,
  não uma migração da intranet. Nunca o proponhas para lá.
- **`migrations/001_radios.sql` é a migração do módulo.** Enquanto não for para a intranet pode
  ser editada; a partir do momento em que correr em produção, alterações à base de dados são
  **ficheiro novo, numerado a seguir** (e na intranet o número vai ser outro — a correspondência
  ficou na 018).

## Ferramentas — três armadilhas locais

- ⚠️ **`sqlcmd` precisa de `-f 65001` para ficheiros com acentos.** Sem isso lê o ficheiro na
  codepage do sistema e grava mojibake na base ("administraÃ§Ã£o"). O erro não aparece à saída
  do `sqlcmd` — só quando a aplicação lê a linha.
- ⚠️ **Caminhos passados ao `sqlcmd` têm de levar barras invertidas.** O `sqlcmd` clássico aceita
  opções com `/`, portanto `-i C:/Users/…` faz o `/Users` ser lido como `-U sers` e a chamada
  morre com "-E and the -U/-P options are mutually exclusive".
- ⚠️ **Sem `#` nas passwords do `.env`.** O `dotenv` corta um valor sem aspas no primeiro
  cardinal, e o que chega ao driver é só o princípio — o erro que se vê é "Login failed".

## Duas bases de dados

- **Os rádios estão na `RadiosDev` e os telemóveis na `TelemoveisDev`.** Duas pools: o `db.js`
  (cópia da intranet) e o `db-telemoveis.js`, que só existe por causa disto.
- ⚠️ **Nunca qualifiques a base no SQL.** Nada de `TelemoveisDev.dbo.telemoveis` nem de nomes
  de três partes: a separação vive na ligação, não nas consultas. **Na intranet os módulos
  partilham a mesma base**, e é assim que juntar tudo é apagar o `DB_DATABASE_TELEMOVEIS` do
  `.env` — sem tocar numa linha de SQL.
- Pela mesma razão **não há consultas que cruzem os dois tipos de activo**. Uma pessoa com um
  rádio e um telemóvel aparece nas duas listas, e não há JOIN possível entre elas.
- As rotas dos telemóveis estão em `server/routes/iga/telemoveis.js` **porque falam com a
  outra pool**, não por serem outro módulo: montam dentro do mesmo router e usam os mesmos
  grupos de acesso.
- O que os dois tipos partilham vive em `server/routes/iga/comum.js` (leitura de campos e
  datas). O recálculo do estado **não** está lá de propósito: conhece as tabelas de cada tipo.

## Base de dados

- **O alvo é SQL Server.** Não escrevas SQL a tentar ser portável, nem introduzas abstracções
  para isso.
- **O `estado` é uma coluna, não uma consulta** — e quem o escreve é o `recalcularEstado()` de
  cada tipo (`radios.js` e `telemoveis.js` têm o seu, porque conhecem as suas tabelas).
  Qualquer coisa que mexa em atribuições, avarias ou abates tem de o chamar a seguir; **SQL
  escrito à mão que apague uma dessas linhas deixa o estado desalinhado** (o `README` tem o
  UPDATE que repõe tudo). A precedência é abatido > avariado > atribuído > disponível.
- **Ao contrário da correspondência, aqui as datas são `DATE` a sério.** A origem trazia datas
  do Excel, não texto; a excepção é a folha `Quest`, cujas datas vêm em texto "17-Oct-25" e são
  convertidas na importação, com o cru guardado ao lado em `data_resposta_texto`.
- **`num_serie` é único mas só quando existe** (índice filtrado): os dois rádios criados sem
  ficha do master (ver abaixo) não têm série, e isso é esperado, não sujidade para limpar.
- **`indicativo` é efectivamente único agora.** As reatribuições nunca fechadas que existiam na
  folha antiga (357, 847, 849…) eram um artefacto dela — não existem no `master radios.xlsx`,
  cujo ALIAS é uma chave a sério. Se voltares a ver indicativos duplicados, é sinal de que algo
  está a criar rádios em vez de encontrar os que já existem — ver `importarMaster()`.

## As duas fontes actuais, e o que elas pregam

`master radios.xlsx` (ALIAS, S/N, TEI, ISSI, Marca, Modelo — 765 linhas) diz QUE equipamento
existe; `atribuidos.xlsx` (email, utilizador, matrícula, Nº rádio — ~197 linhas) diz QUEM tem
cada um agora. Substituem por completo o `Radios apanhado.xlsx` de 7 folhas e as fontes TETRA
que vieram depois (`TEI radios.xlsx`, a folha `TEI` antiga) — essas ficaram só no histórico do
git. `scripts/importar_radios.js` não lê mais nenhuma delas.

- ⚠️ **O `atribuidos.xlsx` não tem datas.** As entregas desta importação levam todas
  `DATA_ATRIBUICAO_PADRAO` (2025-10-01, fixa no código) — é quando o levantamento foi feito, não
  quando a entrega aconteceu de facto. Isso perdeu-se; não se inventa.
- ⚠️ **Há pessoas repetidas no ficheiro, com rádios diferentes.** A regra é a última linha vale
  (decisão do utilizador) — `importarAtribuicoes()` agrupa por matrícula num `Map`, que guarda só
  a última escrita.
- ⚠️ **Dois rádios têm DUAS pessoas diferentes a reclamá-los** (não é a mesma pessoa duas vezes —
  são pessoas distintas). Isso o importador não decide sozinho: `RADIOS_EM_CONFLITO` marca-os, e
  as linhas dos dois lados ficam de fora, visíveis em `resumo.atribuidos.em_conflito`. Resolve-se
  pelo ecrã (entregar a quem for) quando se souber quem tem o rádio a sério.
- ⚠️ **Um valor "34" que devia ser "834" criou um SEGUNDO conflito** quando corrigido — o 834
  já tinha dono legítimo no mesmo ficheiro. Por isso a correcção de um valor mal transcrito não
  se limita a "trocar o número": pode chocar com outra linha. Ver `MATRICULAS_EM_CONFLITO`, que
  trata este caso pontual como os outros conflitos — de fora, à vista, por resolver na origem.
- **Um valor pode descrever MAIS do que um rádio** — "643 (comando) / 349 (Paços do Concelho)",
  a mesma pessoa com dois rádios consoante o local. `numerosDoTexto()` extrai todos os números
  de uma célula; é o único sítio onde uma pessoa fica com mais de uma entrega aberta ao mesmo
  tempo, e é deliberado.
- **Números que não existem no master criam ficha mínima** (só o indicativo, sem série/alias) —
  `radioDoIndicativo()`, com a proveniência marcada em `obs`. Se o master vier a ganhar uma linha
  para esse mesmo indicativo mais tarde, `importarMaster()` completa a ficha em vez de duplicar
  (o terceiro passo da procura, por indicativo único).
- **Não há avarias nem abates nestas duas fontes.** O importador não toca em
  `radios_avarias`/`radios_abates` — ficam como o ecrã os deixar, até haver ficheiro próprio.
- **Sem `--limpar`.** Ao contrário do importador antigo, este sincroniza em vez de destruir: uma
  segunda corrida fecha o que já não bate e abre o que é novo, nunca apaga em bloco. Foi o que
  faltou da primeira vez que se tentou uma fonte nova — custou duplicados e, uma vez, dados reais
  perdidos (ver o histórico do git à volta de "o rádio 666").

## O ficheiro dos telemóveis, e o que ele prega

- ⚠️ **O espaço duro (` `) conta como vazio.** A folha tem 299 células com um NBSP
  sozinho — coluna limpa à barra de espaços. Sem o tratar, 29 matrículas e 2 PIN vazios
  passavam por preenchidos. É o que o `texto()` do `scripts/importar_telemoveis.js` faz.
- **O estado vem de texto livre em quatro colunas** ('Entregue', a segunda 'Data',
  'Localização' e 'OBS.'): "ABATE 2023" aparece onde devia estar um nome. O `classificar()` lê
  isso por palavras, o abate ganha à avaria, e **o texto original fica sempre em `obs`** — a
  decisão do importador tem de poder ser conferida sem voltar ao Excel.
- **A folha tem 301 linhas para 300 aparelhos** (a 124 repete-se na 125, igual até ao PIN). O
  índice único no número faz a segunda cair em cima da primeira, e o resumo conta-a em
  `duplicadas_na_folha` em vez de a esconder num "actualizado".

## Credenciais dos telemóveis

- ⚠️ **Nenhuma consulta de listagem ou de detalhe pode devolver `pin`, `puk`, `utilizador` ou
  `palavra_passe`.** Os SELECT do `telemoveis.js` escrevem as colunas uma a uma e **não há
  `SELECT *`** — é o que faz de acrescentar um campo à listagem uma decisão e não um descuido.
- A única porta é `GET /telemoveis/:id/credenciais`, com `exigirAdmin`, e a leitura fica no
  log. O `PUT` também só grava credenciais a quem é `canAdmin`, e só os campos que vierem no
  corpo: um formulário sem eles não pode apagá-las por omissão.
- **O PIN não se completa com zeros à esquerda**, por muito que "20" seja obviamente "0020".
  Dez tentativas erradas pedem o PUK. O ecrã avisa, o código não adivinha.

## Autorização

- O gate de VER está aplicado **ao router inteiro** (`router.use(exigirAcesso)`, logo a seguir a
  `/permissoes`). **Rotas novas vão dentro dele**; as que mudam dados levam `exigirEdicao`, e o
  abate e a remoção `exigirAdmin`.
- **Não acrescentes autenticação.** A identidade vem do Windows (SSPI) na intranet e é injectada
  pelo harness em desenvolvimento.
- Nunca leias `x-remote-user` directamente — só `req.user`.
- `canAdmin` é só do grupo `IGA-Admin`: ser administrador da consola AD-PM **não** abre o
  abate. É de propósito — senão, desactivar alguém no grupo não tinha efeito nenhum.

## Uma página por tipo de equipamento

- **`public/radios.html` e `public/telemoveis.html` são independentes, e é deliberado.** Não
  há motor partilhado entre elas, nem separadores dentro de uma página: cada tipo tem o seu
  ecrã, e o próximo equipamento será outra página. Foi decidido assim com o custo à vista —
  **não "arrumes" isto para um ficheiro comum** por parecer duplicação; é uma escolha, não um
  descuido. Se algum dia for para mudar, é conversa a ter, não uma refactorização de passagem.
- **`public/iga.html` é a porta de entrada** — um cartão por equipamento, com as contagens, e
  é para lá que a raiz reencaminha. Não tem lógica de inventário nenhuma: só lê os
  `/estatisticas` de cada tipo e abre a página respectiva. O cabeçalho das outras páginas traz
  de volta a ela.
- **As páginas de equipamento NÃO têm barra de navegação entre tipos.** Estando na página dos
  rádios não se vê o botão dos telemóveis, e vice-versa — cada página é dedicada ao seu tipo.
  A navegação entre tipos é sempre pela entrada: cabeçalho → `iga.html` → outro cartão. Por
  isso **a lista de tipos vive num só sítio**, o `TIPOS` do `iga.html`; não a espalhes pelas
  páginas com um `<nav>` de atalhos — foi tirado de propósito.
- Os cartões da entrada **toleram uma API em baixo**: cada tipo é lido por si, e o que falha
  aparece com o aviso em vez de levar a página atrás. A base dos telemóveis é outra e pode
  estar em baixo sozinha.
- O que **é** partilhado, e continua a sê-lo: o servidor (`server/routes/iga/`, um router
  por tipo montado no `index.js`), as permissões, e os assets em `public/iga/`.
- O passo a passo para juntar um tipo novo está no README, secção *Acrescentar um tipo de
  equipamento*.

## Ao mexer no código

- **Não há build.** Cada página é HTML, CSS e JavaScript num ficheiro só, servido
  directamente: guardar e recarregar chega.
- Alterações em `server/routes/iga/` obrigam a **reiniciar o harness**. O
  `permissoes.js` tem uma cache de 10 minutos por utilizador: depois de mexer em
  `colaboradores` ou nos grupos, reiniciar é a única forma de ver o efeito.
- ⚠️ **A ordem das rotas nos ficheiros é significativa.** O Express serve a primeira que casa e
  o `/:id` apanha qualquer palavra, portanto rotas de nome fixo (`/sistema`, `/conferencia`,
  `/utilizadores`, `/estatisticas`) vão **acima** do `/:id`. Restringir o parâmetro com
  `/:id(\d+)` **não funciona** nesta versão do Express (4.22): a rota deixa de casar de todo e
  o pedido morre num "Cannot GET". Já foi tentado; o detalhe do rádio dava 404.
- O Tailwind e o lucide são **ficheiros locais** em `public/iga/`, não vêm de CDN.
- **O `.env` nunca entra no git.** Variáveis novas documentam-se no `.env.example`, sem valores.

## Convenções

- **Código e comentários em português.** Os nomes de domínio ficam como estão: `indicativo`,
  `matricula`, `guia`, `abate`, `alias`, `talkgroup`.
- Mantém o estilo dos ficheiros à volta — os comentários explicam **porquê**, não o quê.
- Alterações cirúrgicas: mexe no que é preciso e não aproveites a boleia para reorganizar o resto.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/` in this repo. See
`docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, using their default label strings. See
`docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
