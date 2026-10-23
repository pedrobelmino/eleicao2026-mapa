/**
 * Geometria pura para o painel de locais de votação.
 *
 * Este módulo não conhece DOM, MapLibre nem o backend: recebe os objetos de
 * votos já no formato do backend e devolve GeoJSON. Tudo aqui é determinístico,
 * sem efeitos colaterais e sem imports.
 */

export const LIMITE_PREDIOS = 400;

const LADO_MIN_PADRAO_M = 60;
const LADO_MAX_PADRAO_M = 240;
const ALTURA_MIN_PADRAO_M = 30;
const ALTURA_MAX_PADRAO_M = 450;

const BASE_PADRAO_M = 0;
const LADO_CELULA_PADRAO_M = 45;
const VAO_PADRAO_M = 10;

// Larguras dos dois losangos de zona. Os números foram medidos na captura
// (z≈8.5 ~216 m/px, z≈10.5 ~54 m/px); o largo é lido na aproximação (z≈7.4 a
// 9.9) e o fino no nível de cidade (z≈9.3 a 12.2). A projeção muda os metros
// por pixel a cada nível de zoom, então a mesma largura em metros não serve
// para as duas faixas.
const LADO_LARGO_MIN_PADRAO_M = 2000;
const LADO_LARGO_MAX_PADRAO_M = 4000;
const LADO_FINO_MIN_PADRAO_M = 500;
const LADO_FINO_MAX_PADRAO_M = 1400;

const METROS_POR_GRAU_LAT = 110540;
const METROS_POR_GRAU_LON_EQUADOR = 111320;
const COS_MINIMO = 1e-9;

/**
 * Converte um valor para número finito, usando o padrão quando não for possível.
 * Evita que um campo ausente/NaN contamine as propriedades e as coordenadas.
 */
function numeroFinito(valor, padrao = 0) {
  const numero = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : padrao;
}

/** Garante que textos opcionais virem string sem transformar null/undefined em "null". */
function texto(valor) {
  if (typeof valor === 'string') return valor;
  return valor == null ? '' : String(valor);
}

/**
 * O TSE usa (-1, -1) e, em alguns casos, (0, 0) como sentinela de "sem
 * coordenada". Também descartamos valores não finitos. Não descartamos um
 * latitude -1 legítima acompanhada de longitude diferente de -1.
 */
function coordenadaValida(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  if (lat === -1 && lon === -1) return false;
  return true;
}

/** Limita o percentual apurado a 0..100; ausente/NaN vira 100 (obra concluída). */
function normalizarPct(pct) {
  if (!Number.isFinite(pct)) return 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Hash FNV-1a de 32 bits. É pequeno, estável entre execuções e independente de
 * Math.random(), então a rotação de cada prédio nunca muda entre recarregamentos.
 */
function hashInteiro(textoEntrada) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < textoEntrada.length; i += 1) {
    hash ^= textoEntrada.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Fator de conversão de metros para graus na latitude informada.
 * O cosseno é protegido em módulo para nunca dividir por zero perto dos polos.
 */
function fatoresGraus(lat) {
  const cosLat = Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), COS_MINIMO);
  return {
    dLat: 1 / METROS_POR_GRAU_LAT,
    dLon: 1 / (METROS_POR_GRAU_LON_EQUADOR * cosLat),
  };
}

/**
 * Retângulo fechado (5 posições) centrado em (lat, lon), com largura/altura em
 * metros e rotação em graus. A rotação é feita no plano local em metros e só
 * depois convertida para graus, o que mantém o retângulo previsível.
 */
function anelRetangulo(lat, lon, larguraM, alturaM, anguloGraus) {
  const meiaLargura = larguraM / 2;
  const meiaAltura = alturaM / 2;
  const rad = (anguloGraus * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sen = Math.sin(rad);
  const { dLat, dLon } = fatoresGraus(lat);

  // Sentido anti-horário no plano local (x = leste, y = norte).
  const cantos = [
    [-meiaLargura, -meiaAltura],
    [meiaLargura, -meiaAltura],
    [meiaLargura, meiaAltura],
    [-meiaLargura, meiaAltura],
  ];

  const anel = [];
  for (let i = 0; i < cantos.length; i += 1) {
    const [x, y] = cantos[i];
    const xRotacionado = x * cos - y * sen;
    const yRotacionado = x * sen + y * cos;
    anel.push([lon + xRotacionado * dLon, lat + yRotacionado * dLat]);
  }
  // Fecha o anel repetindo o primeiro ponto, como exige o GeoJSON.
  anel.push([anel[0][0], anel[0][1]]);
  return anel;
}

/**
 * Filtra locais sem coordenada e calcula o maior vv uma única vez. Esse máximo
 * é a referência das duas escalas do prédio: sqrt para a base e linear para a
 * altura.
 */
function prepararLocais(locais) {
  const itens = [];
  let maiorVv = 0;

  if (!Array.isArray(locais)) return { itens, maiorVv };

  for (let i = 0; i < locais.length; i += 1) {
    const local = locais[i];
    if (!local) continue;

    const lat = numeroFinito(local.lat, NaN);
    const lon = numeroFinito(local.lon, NaN);
    if (!coordenadaValida(lat, lon)) continue;

    // Votos negativos não fazem sentido geométrico; tratamos como zero.
    const vv = Math.max(0, numeroFinito(local.vv, 0));
    itens.push({ local, lat, lon, vv });
    if (vv > maiorVv) maiorVv = vv;
  }

  return { itens, maiorVv };
}

/** Escala de altura usada tanto nos prédios quanto nos pontos 2D. */
function calcularAlturaTotal(vv, maiorVv, alturaMinM, alturaMaxM) {
  const proporcao = maiorVv > 0 ? Math.min(1, vv / maiorVv) : 0;
  // Linear em votos válidos: a diferença de altura é percebida de forma direta.
  return alturaMinM + (alturaMaxM - alturaMinM) * proporcao;
}

/**
 * Gera um Polygon por local válido.
 *
 * Decisões:
 * - a base cresce com sqrt(vv), suavizando a diferença entre locais pequenos;
 * - a altura cresce linearmente com vv, para que o volume conte a história;
 * - a cor ocupa a fração apurada e o concreto fica no topo (fração pendente).
 */
export function construirPredios(locais, opcoes) {
  const {
    ladoMinM = LADO_MIN_PADRAO_M,
    ladoMaxM = LADO_MAX_PADRAO_M,
    alturaMinM = ALTURA_MIN_PADRAO_M,
    alturaMaxM = ALTURA_MAX_PADRAO_M,
  } = opcoes ?? {};

  const { itens, maiorVv } = prepararLocais(locais);
  const features = [];

  for (let i = 0; i < itens.length; i += 1) {
    const { local, lat, lon, vv } = itens[i];
    const proporcaoSqrt = maiorVv > 0 ? Math.sqrt(vv / maiorVv) : 0;
    const ladoM = maiorVv > 0
      ? ladoMinM + (ladoMaxM - ladoMinM) * proporcaoSqrt
      : ladoMinM;

    const alturaTotalM = calcularAlturaTotal(vv, maiorVv, alturaMinM, alturaMaxM);
    const pct = normalizarPct(local.pct_apurado);
    const alturaCorM = alturaTotalM * (pct / 100);
    const alturaConcretoM = alturaTotalM - alturaCorM;

    // O resto por 90 dá um ângulo inteiro em [0, 89], estável para o mesmo
    // nr_local. Não há Math.random(): recarregar o painel não muda a geometria.
    const angulo = hashInteiro(String(local.nr_local)) % 90;
    const anel = anelRetangulo(lat, lon, ladoM, ladoM, angulo);

    features.push({
      type: 'Feature',
      id: String(local.nr_local),
      properties: {
        nr_local: local.nr_local,
        vv,
        total: numeroFinito(local.total, 0),
        lider: texto(local.lider),
        partido_lider: texto(local.partido_lider),
        pct_apurado: pct,
        lado_m: ladoM,
        altura_total_m: alturaTotalM,
        altura_cor_m: alturaCorM,
        altura_concreto_m: alturaConcretoM,
        altura_concreto_base_m: alturaCorM,
        raio_efetivo_m: Math.hypot(ladoM / 2, ladoM / 2),
      },
      geometry: {
        type: 'Polygon',
        coordinates: [anel],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Deriva o partido da seção pelos votos: PL quando 22 é o maior, PT quando 13
 * é o maior. Empate em zero não escolhe partido. "voutros" vence => ''.
 */
function derivarPartidoSecao(secao) {
  const v13 = Math.max(0, numeroFinito(secao.v13, 0));
  const v22 = Math.max(0, numeroFinito(secao.v22, 0));
  const voutros = Math.max(0, numeroFinito(secao.voutros, 0));

  if (v22 === 0 && v13 === 0) return '';
  if (v22 >= v13 && v22 >= voutros) return 'PL';
  if (v13 >= voutros) return 'PT';
  return '';
}

function colecaoVazia() {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * Gera a grade de urnas sobre o local e a placa que cobre a grade.
 *
 * As células não são rotacionadas; o espaçamento é ladoCelulaM + vaoM e a grade
 * inteira fica centralizada no ponto do local. A placa ganha meia célula de
 * margem em cada lado, por isso suas dimensões são ladoM + ladoCelulaM e
 * alturaDaGrade + ladoCelulaM.
 */
export function construirUrnas(local, opcoes) {
  if (!local || !Array.isArray(local.secoes) || local.secoes.length === 0) {
    return {
      colecao: colecaoVazia(),
      placa: colecaoVazia(),
      colunas: 0,
      linhas: 0,
      ladoM: 0,
      alturaMaxM: 0,
    };
  }

  const lat = numeroFinito(local.lat, NaN);
  const lon = numeroFinito(local.lon, NaN);
  if (!coordenadaValida(lat, lon)) {
    return {
      colecao: colecaoVazia(),
      placa: colecaoVazia(),
      colunas: 0,
      linhas: 0,
      ladoM: 0,
      alturaMaxM: 0,
    };
  }

  const {
    baseM = BASE_PADRAO_M,
    ladoCelulaM = LADO_CELULA_PADRAO_M,
    vaoM = VAO_PADRAO_M,
  } = opcoes ?? {};

  const base = numeroFinito(baseM, BASE_PADRAO_M);
  const ladoCelula = numeroFinito(ladoCelulaM, LADO_CELULA_PADRAO_M);
  const vao = numeroFinito(vaoM, VAO_PADRAO_M);

  const n = local.secoes.length;
  const colunas = Math.ceil(Math.sqrt(n));
  const linhas = Math.ceil(n / colunas);
  const ladoM = colunas * ladoCelula + (colunas - 1) * vao;
  const alturaGradeM = linhas * ladoCelula + (linhas - 1) * vao;

  let maiorVvSecao = 0;
  for (let i = 0; i < n; i += 1) {
    const vv = Math.max(0, numeroFinito(local.secoes[i].vv, 0));
    if (vv > maiorVvSecao) maiorVvSecao = vv;
  }

  const { dLat, dLon } = fatoresGraus(lat);
  const features = [];
  let maiorAlturaM = 0;

  for (let i = 0; i < n; i += 1) {
    const secao = local.secoes[i];
    const vv = Math.max(0, numeroFinito(secao.vv, 0));
    const proporcao = maiorVvSecao > 0 ? vv / maiorVvSecao : 0;
    // Cada urna mede ao menos 6 m; a maior seção chega a 66 m.
    const alturaM = 6 + 60 * proporcao;

    const coluna = i % colunas;
    const linha = Math.floor(i / colunas);
    const deslocamentoX = (coluna - (colunas - 1) / 2) * (ladoCelula + vao);
    const deslocamentoY = (linha - (linhas - 1) / 2) * (ladoCelula + vao);
    const latCelula = lat + deslocamentoY * dLat;
    const lonCelula = lon + deslocamentoX * dLon;
    const anel = anelRetangulo(latCelula, lonCelula, ladoCelula, ladoCelula, 0);

    features.push({
      type: 'Feature',
      properties: {
        zona: secao.zona,
        secao: secao.secao,
        vv,
        total: numeroFinito(secao.total, 0),
        lider: texto(secao.lider),
        partido_lider: derivarPartidoSecao(secao),
        pct_apurado: normalizarPct(secao.pct_apurado),
        altura_m: alturaM,
        base_m: base,
        indice: i,
        coluna,
        linha,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [anel],
      },
    });

    if (alturaM > maiorAlturaM) maiorAlturaM = alturaM;
  }

  const larguraPlacaM = ladoM + ladoCelula;
  const alturaPlacaM = alturaGradeM + ladoCelula;
  const anelPlaca = anelRetangulo(lat, lon, larguraPlacaM, alturaPlacaM, 0);

  const placa = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          lado_m: ladoM,
          colunas,
          linhas,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [anelPlaca],
        },
      },
    ],
  };

  return {
    colecao: { type: 'FeatureCollection', features },
    placa,
    colunas,
    linhas,
    ladoM,
    // Altura absoluta do topo mais alto, útil para enquadrar a câmera.
    alturaMaxM: base + maiorAlturaM,
  };
}

/**
 * Fallback 2D: um Point por local válido, com raio e altura proporcionais a vv.
 * A altura usa exatamente a mesma escala linear de construirPredios.
 *
 * As propriedades repetem as do prédio e as que o tooltip/cartão do local já
 * consumiam (margem, agrupamento, contagem de seções), para a camada de pontos
 * poder substituir a de prédios sem perder informação.
 */
export function pontosDosLocais(locais) {
  const { itens, maiorVv } = prepararLocais(locais);
  const features = [];

  for (let i = 0; i < itens.length; i += 1) {
    const { local, lat, lon, vv } = itens[i];
    const proporcao = maiorVv > 0 ? Math.min(1, vv / maiorVv) : 0;
    const raioM = 4 + 8 * Math.sqrt(proporcao);
    const alturaM = calcularAlturaTotal(
      vv,
      maiorVv,
      ALTURA_MIN_PADRAO_M,
      ALTURA_MAX_PADRAO_M,
    );
    const secoes = Array.isArray(local.secoes) ? local.secoes : [];

    features.push({
      type: 'Feature',
      id: String(local.nr_local),
      properties: {
        nr_local: local.nr_local,
        vv,
        total: numeroFinito(local.total, 0),
        v13: numeroFinito(local.v13, 0),
        v22: numeroFinito(local.v22, 0),
        voutros: numeroFinito(local.voutros, 0),
        lider: texto(local.lider),
        partido_lider: texto(local.partido_lider),
        lider_pct: numeroFinito(local.lider_pct, 0),
        margem_votos: numeroFinito(local.margem_votos, 0),
        margem_pct: numeroFinito(local.margem_pct, 0),
        pct_apurado: normalizarPct(local.pct_apurado),
        secoes_apuradas: numeroFinito(local.secoes_apuradas, secoes.length),
        secoes_esperadas: numeroFinito(local.secoes_esperadas, secoes.length),
        agrupado: Boolean(local.agrupado),
        nr_locais: Array.isArray(local.nr_locais) ? local.nr_locais : [],
        secao: secoes.length,
        raio_m: raioM,
        altura_m: alturaM,
      },
      geometry: {
        type: 'Point',
        coordinates: [lon, lat],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Área assinada (shoelace) de um anel no plano lon/lat. O valor absoluto serve
 * para escolher o anel externo de maior área em MultiPolygon; o sinal depende
 * apenas da orientação do anel.
 */
function areaAssinada(anel) {
  if (!Array.isArray(anel) || anel.length < 3) return 0;
  let soma = 0;
  for (let i = 0; i < anel.length; i += 1) {
    const atual = anel[i];
    const proximo = anel[(i + 1) % anel.length];
    const x0 = numeroFinito(atual?.[0], NaN);
    const y0 = numeroFinito(atual?.[1], NaN);
    const x1 = numeroFinito(proximo?.[0], NaN);
    const y1 = numeroFinito(proximo?.[1], NaN);
    if (
      !Number.isFinite(x0) ||
      !Number.isFinite(y0) ||
      !Number.isFinite(x1) ||
      !Number.isFinite(y1)
    ) {
      return NaN;
    }
    soma += x0 * y1 - x1 * y0;
  }
  return soma / 2;
}

/** Anel externo de um Polygon ou o de maior área absoluta de um MultiPolygon. */
function anelExternoDaZona(geometria) {
  if (!geometria || !Array.isArray(geometria.coordinates)) return null;

  if (geometria.type === 'Polygon') {
    return Array.isArray(geometria.coordinates[0])
      ? geometria.coordinates[0]
      : null;
  }

  if (geometria.type === 'MultiPolygon') {
    let escolhido = null;
    let maiorArea = -Infinity;
    for (let i = 0; i < geometria.coordinates.length; i += 1) {
      const poligono = geometria.coordinates[i];
      const anel = Array.isArray(poligono) ? poligono[0] : null;
      if (!Array.isArray(anel)) continue;
      const area = Math.abs(areaAssinada(anel));
      // Anel degenerado (área 0) ainda pode ser o único; NaN é descartado.
      if (!Number.isFinite(area)) continue;
      if (area > maiorArea) {
        maiorArea = area;
        escolhido = anel;
      }
    }
    return escolhido;
  }

  return null;
}

/**
 * Centroide de área (shoelace) do anel externo. Se o cálculo degenerar (área
 * zero/NaN) ou o anel tiver menos de 3 pontos, usa a média aritmética das
 * coordenadas do anel. Devolve [lon, lat] ou null quando não há coordenada.
 */
function centroideDaZona(anel) {
  if (!Array.isArray(anel) || anel.length === 0) return null;

  if (anel.length >= 3) {
    let soma = 0;
    let somaX = 0;
    let somaY = 0;
    let finito = true;

    for (let i = 0; i < anel.length; i += 1) {
      const atual = anel[i];
      const proximo = anel[(i + 1) % anel.length];
      const x0 = numeroFinito(atual?.[0], NaN);
      const y0 = numeroFinito(atual?.[1], NaN);
      const x1 = numeroFinito(proximo?.[0], NaN);
      const y1 = numeroFinito(proximo?.[1], NaN);
      if (
        !Number.isFinite(x0) ||
        !Number.isFinite(y0) ||
        !Number.isFinite(x1) ||
        !Number.isFinite(y1)
      ) {
        finito = false;
        break;
      }
      const cruz = x0 * y1 - x1 * y0;
      soma += cruz;
      somaX += (x0 + x1) * cruz;
      somaY += (y0 + y1) * cruz;
    }

    const area = soma / 2;
    if (finito && Number.isFinite(area) && area !== 0) {
      const lon = somaX / (6 * area);
      const lat = somaY / (6 * area);
      if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
    }
  }

  // Fallback: média aritmética das coordenadas válidas do anel.
  let somaX = 0;
  let somaY = 0;
  let total = 0;
  for (let i = 0; i < anel.length; i += 1) {
    const x = numeroFinito(anel[i]?.[0], NaN);
    const y = numeroFinito(anel[i]?.[1], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    somaX += x;
    somaY += y;
    total += 1;
  }
  if (total === 0) return null;
  return [somaX / total, somaY / total];
}

/**
 * Prepara as zonas eleitorais para as TRÊS formas que o mapa desenha:
 *
 * - `forma: 'area'`       -> o polígono original, usado na faixa de estado;
 * - `forma: 'barra'`      -> losango LARGO no centroide da zona, lido na
 *   aproximação (z≈7.4 a 9.9);
 * - `forma: 'barra-fina'` -> losango ESTREITO no mesmo centroide, lido no
 *   nível de cidade (z≈9.3 a 12.2).
 *
 * Por que duas barras: o losango tem tamanho fixo em METROS, mas a projeção
 * muda a quantidade de metros por pixel a cada nível de zoom (≈216 m/px em
 * z=8.5 e ≈54 m/px em z=10.5). A largura em metros precisa acompanhar essa
 * mudança, e como não se pode usar expressão de `zoom` dentro de
 * fill-extrusion-height/base, quem faz a troca é o par minzoom/maxzoom das
 * camadas — NUNCA uma expressão de zoom na altura. As duas barras usam as
 * MESMAS alturas e bases de cidade; só a largura do losango muda.
 *
 * Cada forma mantém TODAS as propriedades da área (inclusive bar_lula,
 * bar_flavio, bar_outros, bar_nao_apurado e altura_m) e ganha `forma`. O lado
 * de cada losango cresce com sqrt(vv / maiorVv), a mesma suavização usada nos
 * locais. É geometria pura, determinística e sem DOM.
 */
export function prepararZonas(zonasGeo, opcoes) {
  const featuresEntrada = Array.isArray(zonasGeo?.features)
    ? zonasGeo.features
    : [];
  if (featuresEntrada.length === 0) {
    return { colecao: colecaoVazia(), areas: 0, barras: 0, barrasFinas: 0 };
  }

  const {
    ladoLargoMinM = LADO_LARGO_MIN_PADRAO_M,
    ladoLargoMaxM = LADO_LARGO_MAX_PADRAO_M,
    ladoMinM = LADO_FINO_MIN_PADRAO_M,
    ladoMaxM = LADO_FINO_MAX_PADRAO_M,
  } = opcoes ?? {};
  const ladoLargoMin = numeroFinito(ladoLargoMinM, LADO_LARGO_MIN_PADRAO_M);
  const ladoLargoMax = numeroFinito(ladoLargoMaxM, LADO_LARGO_MAX_PADRAO_M);
  const ladoMin = numeroFinito(ladoMinM, LADO_FINO_MIN_PADRAO_M);
  const ladoMax = numeroFinito(ladoMaxM, LADO_FINO_MAX_PADRAO_M);

  // O maior vv é a referência da escala e é calculado sobre a coleção inteira,
  // inclusive nas zonas que depois não gerarem barra por falta de coordenada.
  let maiorVv = 0;
  for (let i = 0; i < featuresEntrada.length; i += 1) {
    const feature = featuresEntrada[i];
    if (!feature) continue;
    const vv = Math.max(0, numeroFinito(feature.properties?.vv, 0));
    if (vv > maiorVv) maiorVv = vv;
  }

  const features = [];
  let areas = 0;
  let barras = 0;
  let barrasFinas = 0;

  for (let i = 0; i < featuresEntrada.length; i += 1) {
    const feature = featuresEntrada[i];
    if (!feature) continue;

    const propriedades =
      feature.properties && typeof feature.properties === 'object'
        ? feature.properties
        : {};

    // A área é a geometria original, intacta; só ganha o discriminante.
    const featureArea = {
      type: 'Feature',
      properties: { ...propriedades, forma: 'area' },
      geometry: feature.geometry,
    };
    if (feature.id !== undefined) featureArea.id = feature.id;
    features.push(featureArea);
    areas += 1;

    const anel = anelExternoDaZona(feature.geometry);
    const centro = centroideDaZona(anel);
    if (!centro) continue;

    const [lon, lat] = centro;
    if (!coordenadaValida(lat, lon)) continue;

    // As duas barras compartilham o MESMO centroide e o mesmo anel de 45°;
    // só o lado muda para compensar a escala da projeção em cada faixa.
    const vv = Math.max(0, numeroFinito(propriedades.vv, 0));
    const proporcao = maiorVv > 0 ? Math.sqrt(vv / maiorVv) : 0;
    const ladoLargoM = ladoLargoMin + (ladoLargoMax - ladoLargoMin) * proporcao;
    const ladoFinoM = ladoMin + (ladoMax - ladoMin) * proporcao;
    const anelBarra = anelRetangulo(lat, lon, ladoLargoM, ladoLargoM, 45);
    const anelBarraFina = anelRetangulo(lat, lon, ladoFinoM, ladoFinoM, 45);

    const featureBarra = {
      type: 'Feature',
      properties: { ...propriedades, forma: 'barra' },
      geometry: {
        type: 'Polygon',
        coordinates: [anelBarra],
      },
    };
    features.push(featureBarra);
    barras += 1;

    const featureBarraFina = {
      type: 'Feature',
      properties: { ...propriedades, forma: 'barra-fina' },
      geometry: {
        type: 'Polygon',
        coordinates: [anelBarraFina],
      },
    };
    features.push(featureBarraFina);
    barrasFinas += 1;
  }

  return {
    colecao: { type: 'FeatureCollection', features },
    areas,
    barras,
    barrasFinas,
  };
}
