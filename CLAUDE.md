# Inventário e Gestão de Ativos — instruções para agentes

Este repositório é **um módulo destacado da intranet da Polícia Municipal de Lisboa**, não um
projecto autónomo. A casa a sério do código é o repositório da intranet; aqui está só a gestão
de rádios, com o mínimo à volta para arrancar. É o mesmo molde do `correspondencia-pm`
(`C:\Apps\CorrespondenciaDEV\correspondencia-pm`) — quando houver dúvida sobre convenções, é lá
que se vai ver.

O `README.md` explica como montar e correr. Este ficheiro tem **apenas os gotchas** — o que não
se descobre a ler o código, e o que já correu mal antes.

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
- As rotas dos telemóveis estão em `server/routes/radios/telemoveis.js` **porque falam com a
  outra pool**, não por serem outro módulo: montam dentro do mesmo router e usam os mesmos
  grupos de acesso.
- O que os dois tipos partilham vive em `server/routes/radios/comum.js` (leitura de campos e
  datas). O recálculo do estado **não** está lá de propósito: conhece as tabelas de cada tipo.

## Base de dados

- **O alvo é SQL Server.** Não escrevas SQL a tentar ser portável, nem introduzas abstracções
  para isso.
- **`radios.estado` é uma coluna, não uma consulta** — e quem a escreve é `recalcularEstado()`
  em `server/routes/radios/index.js`. Qualquer coisa que mexa em atribuições, avarias ou abates
  tem de a chamar a seguir; **SQL escrito à mão que apague uma dessas linhas deixa o estado
  desalinhado** (o `README` tem o UPDATE que repõe tudo). A precedência é
  abatido > avariado > atribuído > disponível.
- **Ao contrário da correspondência, aqui as datas são `DATE` a sério.** A origem trazia datas
  do Excel, não texto; a excepção é a folha `Quest`, cujas datas vêm em texto "17-Oct-25" e são
  convertidas na importação, com o cru guardado ao lado em `data_resposta_texto`.
- **`num_serie` é único mas só quando existe** (índice filtrado): 132 dos 407 rádios não têm
  número de série e isso é de origem, não é sujidade para limpar.
- ⚠️ **`indicativo` NÃO é único e há repetidos de verdade** (357, 847, 849, 855, 875, 885). São
  reatribuições que nunca foram fechadas. Não os juntes: cada linha é equipamento diferente.

## O ficheiro de origem, e o que ele prega

O `Radios apanhado.xlsx` tem 7 folhas e três armadilhas que já custaram uma importação:

- ⚠️ **As linhas de nota estão em células unidas**, e o `exceljs` devolve o texto da união em
  TODAS as células dela. "Existem mais 7 rádios Secura 2120 sem número" entrava como um rádio
  cujo indicativo, marca, modelo e utilizador eram essa frase. É o que `identidade()` em
  `scripts/importar_xlsx.js` filtra — e as frases vão para `resumo.notas`, que é impresso no
  fim: são 39 rádios reais que o ficheiro conta mas não lista.
- **Três linhas têm uma linha da exportação TEI colada a partir da coluna K.** Só se lêem as
  colunas A..J. Uma delas trouxe também o alias para a coluna do indicativo — daí o
  `indicativoDoAlias()`.
- **`TEI` e `Quest` são fotografias de outros sistemas**, por isso a importação substitui-as por
  inteiro. As outras folhas são acrescentadas sem duplicar.

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
- `canAdmin` é só do grupo `Radios-Admin`: ser administrador da consola AD-PM **não** abre o
  abate. É de propósito — senão, desactivar alguém no grupo não tinha efeito nenhum.

## Ao mexer no código

- **Não há build.** A página é HTML, CSS e JavaScript num ficheiro só, servido directamente:
  guardar e recarregar chega.
- Alterações em `server/routes/radios/` obrigam a **reiniciar o harness**. O
  `permissoes.js` tem uma cache de 10 minutos por utilizador: depois de mexer em
  `colaboradores` ou nos grupos, reiniciar é a única forma de ver o efeito.
- O Tailwind e o lucide são **ficheiros locais** em `public/radios/`, não vêm de CDN.
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
