// v5 - nodemailer Gmail + comportamiento mejorado sin acceso
// api/diagnostico.js

import nodemailer from 'nodemailer';

export default async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://www.afiliapp.cl', 'https://afiliapp.cl'];
  res.setHeader('Access-Control-Allow-Origin', allowed.includes(origin) ? origin : '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const { nombre, organizacion, email, url } = req.body;

  if (!nombre || !organizacion || !email || !url) {
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  }

  const urlLimpia = url.startsWith('http') ? url : `https://${url}`;

  // ── 1. FETCH DEL SITIO ──────────────────────────────────────────────────────
  let html = '';
  let htmlPrivacidad = '';
  let fetchError = false;

  try {
    const resp = await fetch(urlLimpia, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; AfiliappDiagnostico/1.0)',
        'Accept': 'text/html'
      },
      signal: AbortSignal.timeout(10000)
    });
    html = await resp.text();
  } catch (e) {
    fetchError = true;
  }

  if (!fetchError) {
    const privLink = extraerEnlacePrivacidad(html, urlLimpia);
    if (privLink) {
      try {
        const resp2 = await fetch(privLink, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AfiliappDiagnostico/1.0)' },
          signal: AbortSignal.timeout(8000)
        });
        htmlPrivacidad = await resp2.text();
      } catch (_) {}
    }
  }

  // ── 2. ANÁLISIS ─────────────────────────────────────────────────────────────
  const checks = fetchError
    ? generarChecksPendientes()
    : analizarSitio(html, htmlPrivacidad, urlLimpia);

  const puntaje = fetchError ? null : checks.filter(c => c.estado === 'ok').length;
  const total   = checks.length;
  const nivel   = fetchError ? 'pendiente' : puntaje >= 8 ? 'alto' : puntaje >= 5 ? 'medio' : 'bajo';

  // ── 3. EMAIL ─────────────────────────────────────────────────────────────────
  const htmlEmail = generarEmail({ nombre, organizacion, url: urlLimpia, checks, puntaje, total, nivel, fetchError });

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS
      }
    });

    await transporter.sendMail({
      from: `Afiliapp <${process.env.GMAIL_USER}>`,
      to: email,
      bcc: 'contacto@afiliapp.cl',
      subject: fetchError
        ? `📋 Diagnóstico Ley 21.719 — ${organizacion} (revisión manual pendiente)`
        : `📋 Diagnóstico Ley 21.719 — ${organizacion}`,
      html: htmlEmail
    });

    return res.status(200).json({ ok: true, puntaje, total, nivel });

  } catch (e) {
    console.error('Error enviando email:', e.message);
    return res.status(500).json({ error: 'Error al enviar el email', detalle: e.message });
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function normalizar(texto) {
  return texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function contiene(texto, ...palabras) {
  const n = normalizar(texto);
  return palabras.some(p => n.includes(normalizar(p)));
}

function extraerEnlacePrivacidad(html, base) {
  const regex = /href=["']([^"']*(?:privac|datos|privacy)[^"']*)["']/gi;
  const match = regex.exec(html);
  if (!match) return null;
  const href = match[1];
  if (href.startsWith('http')) return href;
  try { return new URL(href, base).href; } catch (_) { return null; }
}

function tieneFormulario(html) {
  return /<form[\s>]/i.test(html);
}

function formularioConCheckbox(html) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map(m => m[0]);
  return forms.some(f => /type=["']checkbox["']/i.test(f));
}

function formularioConTextoPrivacidad(html) {
  const forms = [...html.matchAll(/<form[\s\S]*?<\/form>/gi)].map(m => m[0]);
  return forms.some(f => contiene(f, 'privacidad', 'privacy', 'datos personales', '21.719', '19.628'));
}

function generarChecksPendientes() {
  return [
    { id: 'politica_publicada',      titulo: 'Política de Privacidad publicada',           descripcion: 'El sitio debe tener una página de Política de Privacidad accesible.', recomendacion: 'Publicar una Política de Privacidad en una URL dedicada que cumpla el Art. 14 ter de la Ley 21.719.' },
    { id: 'politica_en_menu',        titulo: 'Enlace a política en menú o footer',         descripcion: 'La política debe ser accesible desde cualquier página.', recomendacion: 'Agregar enlace a la Política de Privacidad en el footer y menú principal.' },
    { id: 'responsable_identificado',titulo: 'Responsable identificado en la política',    descripcion: 'La política debe indicar quién es el responsable del tratamiento.', recomendacion: 'Identificar al responsable con nombre, RUT, domicilio y email (Art. 14 ter).' },
    { id: 'derechos_titulares',      titulo: 'Derechos del titular descritos',             descripcion: 'La política debe informar sobre los derechos de acceso, rectificación, supresión, oposición y portabilidad.', recomendacion: 'Incluir sección de derechos del titular (Art. 4° al 9° Ley 21.719).' },
    { id: 'canal_derechos',          titulo: 'Canal habilitado para ejercer derechos',     descripcion: 'Debe existir un email o formulario dedicado para ejercer derechos.', recomendacion: 'Publicar email dedicado para solicitudes de datos.' },
    { id: 'formulario_aviso',        titulo: 'Aviso de privacidad en formularios',         descripcion: 'Cada formulario debe incluir un aviso sobre el tratamiento de datos.', recomendacion: 'Agregar aviso de privacidad junto a cada formulario.' },
    { id: 'consentimiento_checkbox', titulo: 'Checkbox de consentimiento en formularios',  descripcion: 'Los formularios deben incluir un checkbox de consentimiento explícito.', recomendacion: 'Agregar checkbox obligatorio de consentimiento en formularios.' },
    { id: 'datos_sensibles',         titulo: 'Mención de datos sensibles',                 descripcion: 'Si se tratan datos de afiliación sindical, debe mencionarse en la política.', recomendacion: 'Declarar la afiliación sindical como dato sensible (Art. 2° g) Ley 21.719).' },
    { id: 'terceros_proveedores',    titulo: 'Terceros y proveedores declarados',          descripcion: 'La política debe informar qué terceros tratan datos por cuenta de la organización.', recomendacion: 'Listar proveedores tecnológicos y su ubicación geográfica.' },
    { id: 'brecha_protocolo',        titulo: 'Protocolo de brechas de seguridad',          descripcion: 'Debe existir un protocolo interno para responder ante vulneraciones.', recomendacion: 'Implementar Protocolo de Brechas (Art. 14 sexies Ley 21.719).' },
  ].map(c => ({ ...c, estado: 'pendiente' }));
}

function analizarSitio(html, htmlPriv, urlBase) {
  const textoCompleto = html + ' ' + htmlPriv;
  const hayFormulario = tieneFormulario(html);

  return [
    { id: 'politica_publicada', titulo: 'Política de Privacidad publicada', descripcion: 'El sitio debe tener una página de Política de Privacidad accesible.',
      estado: contiene(html, 'privacidad', 'privacy policy', 'política de privacidad') || extraerEnlacePrivacidad(html, urlBase) ? 'ok' : 'mal',
      recomendacion: 'Publicar una Política de Privacidad en una URL dedicada que cumpla el Art. 14 ter de la Ley 21.719.' },
    { id: 'politica_en_menu', titulo: 'Enlace a política en menú o footer', descripcion: 'La política debe ser accesible desde cualquier página.',
      estado: (() => { const footer = html.match(/<footer[\s\S]*?<\/footer>/i)?.[0] || ''; const nav = html.match(/<nav[\s\S]*?<\/nav>/i)?.[0] || ''; return contiene(footer + nav, 'privacidad', 'privacy') ? 'ok' : 'mal'; })(),
      recomendacion: 'Agregar enlace a la Política de Privacidad en el footer y menú principal.' },
    { id: 'responsable_identificado', titulo: 'Responsable identificado en la política', descripcion: 'La política debe indicar quién es el responsable del tratamiento.',
      estado: htmlPriv && contiene(htmlPriv, 'rut', 'responsable', 'representante', 'domicilio') ? 'ok' : htmlPriv ? 'parcial' : 'mal',
      recomendacion: 'Identificar al responsable con nombre, RUT, domicilio y email (Art. 14 ter).' },
    { id: 'derechos_titulares', titulo: 'Derechos del titular descritos', descripcion: 'La política debe informar sobre los derechos de acceso, rectificación, supresión, oposición y portabilidad.',
      estado: contiene(textoCompleto, 'acceso', 'rectificacion', 'supresion', 'portabilidad') && contiene(textoCompleto, 'derecho') ? 'ok' : 'mal',
      recomendacion: 'Incluir sección de derechos del titular (Art. 4° al 9° Ley 21.719).' },
    { id: 'canal_derechos', titulo: 'Canal habilitado para ejercer derechos', descripcion: 'Debe existir un email o formulario dedicado para ejercer derechos.',
      estado: (() => { const emails = textoCompleto.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || []; return emails.length > 0 ? 'ok' : 'mal'; })(),
      recomendacion: 'Publicar email dedicado para solicitudes de datos.' },
    { id: 'formulario_aviso', titulo: 'Aviso de privacidad en formularios', descripcion: 'Cada formulario debe incluir un aviso sobre el tratamiento de datos.',
      estado: !hayFormulario ? 'ok' : formularioConTextoPrivacidad(html) ? 'ok' : 'mal',
      recomendacion: 'Agregar aviso de privacidad junto a cada formulario.' },
    { id: 'consentimiento_checkbox', titulo: 'Checkbox de consentimiento en formularios', descripcion: 'Los formularios deben incluir un checkbox de consentimiento explícito.',
      estado: !hayFormulario ? 'ok' : formularioConCheckbox(html) ? 'ok' : 'mal',
      recomendacion: 'Agregar checkbox obligatorio de consentimiento en formularios.' },
    { id: 'datos_sensibles', titulo: 'Mención de datos sensibles (afiliación sindical)', descripcion: 'Si se tratan datos de afiliación sindical, debe mencionarse en la política.',
      estado: contiene(textoCompleto, 'afiliacion sindical', 'dato sensible', 'afiliación sindical') ? 'ok' : 'parcial',
      recomendacion: 'Declarar la afiliación sindical como dato sensible (Art. 2° g) Ley 21.719).' },
    { id: 'terceros_proveedores', titulo: 'Terceros y proveedores declarados', descripcion: 'La política debe informar qué terceros tratan datos por cuenta de la organización.',
      estado: contiene(textoCompleto, 'supabase', 'google', 'firebase', 'proveedor', 'tercero', 'encargado') ? 'ok' : 'mal',
      recomendacion: 'Listar proveedores tecnológicos y su ubicación geográfica.' },
    { id: 'brecha_protocolo', titulo: 'Protocolo de brechas de seguridad', descripcion: 'Debe existir un protocolo interno para responder ante vulneraciones.',
      estado: contiene(textoCompleto, 'brecha', 'incidente', 'vulneracion', 'notificara') ? 'parcial' : 'mal',
      recomendacion: 'Implementar Protocolo de Brechas (Art. 14 sexies Ley 21.719).' },
  ];
}

function generarEmail({ nombre, organizacion, url, checks, puntaje, total, nivel, fetchError }) {
  const VERDE    = '#1e3a2f';
  const VERDE2   = '#2d7a4f';
  const ROJO     = '#c0392b';
  const AMARILLO = '#e67e22';
  const GRIS     = '#888888';

  const colorNivel = nivel === 'alto' ? '#27ae60' : nivel === 'medio' ? AMARILLO : nivel === 'pendiente' ? GRIS : ROJO;
  const textoNivel = nivel === 'alto' ? 'Cumplimiento mayoritario — ajustes menores'
    : nivel === 'medio' ? 'Cumplimiento parcial — brechas importantes'
    : nivel === 'pendiente' ? 'Análisis manual pendiente — te contactaremos pronto'
    : 'Cumplimiento bajo — acción urgente requerida';

  function iconoEstado(estado) {
    if (estado === 'ok')       return `<span style="color:#27ae60;font-size:18px;">✅</span>`;
    if (estado === 'parcial')  return `<span style="color:${AMARILLO};font-size:18px;">🟡</span>`;
    if (estado === 'pendiente')return `<span style="color:${GRIS};font-size:18px;">⏳</span>`;
    return                            `<span style="color:${ROJO};font-size:18px;">🔴</span>`;
  }

  const filasChecks = checks.map(c => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;width:32px;text-align:center;">${iconoEstado(c.estado)}</td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;">
        <strong style="color:${VERDE};font-size:14px;">${c.titulo}</strong><br>
        <span style="color:#555;font-size:12px;">${c.descripcion}</span>
        ${c.estado !== 'ok' ? `<br><span style="color:#888;font-size:12px;margin-top:4px;display:block;">💡 <em>${c.recomendacion}</em></span>` : ''}
      </td>
    </tr>`).join('');

  const alertaAcceso = fetchError ? `
    <div style="background:#fff3cd;border-left:4px solid ${AMARILLO};padding:16px 20px;margin-bottom:20px;border-radius:4px;font-size:14px;color:#555;">
      <strong>⚠️ No pudimos analizar tu sitio web automáticamente.</strong><br><br>
      Esto puede ocurrir cuando el servidor restringe el acceso a herramientas automatizadas.<br><br>
      <strong>Un especialista de Afiliapp revisará tu sitio manualmente y te contactará dentro de las próximas 24 horas</strong>
      para entregarte el diagnóstico completo personalizado.
    </div>` : '';

  const puntajeDisplay = fetchError
    ? `<div style="font-size:32px;font-weight:700;color:${GRIS};">Análisis<br>pendiente</div>`
    : `<div style="font-size:42px;font-weight:700;color:${colorNivel};">${puntaje}/${total}</div>
       <div style="color:#555;font-size:13px;margin-top:4px;">puntos de cumplimiento</div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Diagnóstico Ley 21.719</title></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;">
    <tr><td>
      <table width="620" cellpadding="0" cellspacing="0" align="center"
             style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${VERDE};padding:28px 32px;">
            <h1 style="margin:0;color:#fff;font-size:22px;">📋 Diagnóstico Ley 21.719</h1>
            <p style="margin:6px 0 0;color:rgba(255,255,255,0.8);font-size:13px;">Protección de Datos Personales — Chile</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 0;">
            <p style="margin:0;color:#333;font-size:15px;">Hola <strong>${nombre}</strong>,</p>
            <p style="margin:10px 0 0;color:#555;font-size:14px;line-height:1.6;">
              Recibimos tu solicitud de diagnóstico para <strong>${organizacion}</strong>
              (<a href="${url}" style="color:${VERDE2};">${url}</a>)
              respecto de la <strong>Ley N° 21.719</strong>, vigente desde el <strong>1 de diciembre de 2026</strong>.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 32px;">
            <div style="background:#f8f8f8;border-radius:8px;padding:20px 24px;text-align:center;border-left:5px solid ${colorNivel};">
              ${puntajeDisplay}
              <div style="color:${colorNivel};font-size:13px;font-weight:600;margin-top:8px;">${textoNivel}</div>
            </div>
          </td>
        </tr>
        ${fetchError ? `<tr><td style="padding:0 32px;">${alertaAcceso}</td></tr>` : ''}
        <tr>
          <td style="padding:0 32px 24px;">
            <h2 style="font-size:15px;color:${VERDE};margin:0 0 12px;">
              ${fetchError ? 'Checklist de verificación (revisión manual pendiente)' : 'Detalle del diagnóstico'}
            </h2>
            ${fetchError ? `<p style="font-size:13px;color:#888;margin:0 0 12px;">Los siguientes puntos serán verificados manualmente por nuestro equipo:</p>` : ''}
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:6px;">
              ${filasChecks}
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <table cellpadding="0" cellspacing="0"><tr>
              <td style="padding-right:16px;font-size:12px;color:#555;">✅ Cumple</td>
              <td style="padding-right:16px;font-size:12px;color:#555;">🟡 Cumple parcialmente</td>
              <td style="padding-right:16px;font-size:12px;color:#555;">🔴 No cumple</td>
              ${fetchError ? `<td style="font-size:12px;color:#555;">⏳ Pendiente revisión</td>` : ''}
            </tr></table>
          </td>
        </tr>
        <tr><td style="padding:0 32px;"><hr style="border:none;border-top:1px solid #eee;margin:0;"></td></tr>
        <tr>
          <td style="padding:24px 32px;">
            <h2 style="font-size:15px;color:${VERDE};margin:0 0 10px;">¿Quieres regularizar tu organización?</h2>
            <p style="margin:0 0 16px;color:#555;font-size:13px;line-height:1.6;">
              En <strong>Afiliapp</strong> implementamos todos los ajustes necesarios para cumplir la Ley 21.719
              antes del 1 de diciembre de 2026: Política de Privacidad, avisos en formularios,
              cláusula de incorporación, consentimiento digital y protocolo de brechas.
            </p>
            <table cellpadding="0" cellspacing="0"><tr><td>
              <a href="https://www.afiliapp.cl/#contacto"
                 style="display:inline-block;background:${VERDE2};color:#fff;text-decoration:none;
                        padding:12px 28px;border-radius:6px;font-size:14px;font-weight:700;">
                Solicitar implementación →
              </a>
            </td></tr></table>
            <p style="margin:12px 0 0;color:#888;font-size:12px;">
              contacto@afiliapp.cl &nbsp;|&nbsp; +56 9 3207 6628
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:0 32px 24px;">
            <div style="background:#f0f8f4;border-radius:6px;padding:16px 20px;">
              <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:${VERDE};">Tarifas para organizaciones sin fines de lucro</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;color:#555;">
                <tr><td style="padding:4px 0;">📄 Solo sitio web</td><td style="text-align:right;font-weight:600;color:${VERDE};">desde $250.000</td></tr>
                <tr><td style="padding:4px 0;">📱 Sitio web + app</td><td style="text-align:right;font-weight:600;color:${VERDE};">desde $450.000</td></tr>
                <tr><td style="padding:4px 0;">🔄 Mantención anual</td><td style="text-align:right;font-weight:600;color:${VERDE};">desde $80.000/año</td></tr>
              </table>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f8f8f8;padding:16px 32px;border-top:1px solid #eee;">
            <p style="margin:0;font-size:11px;color:#aaa;text-align:center;">
              Este diagnóstico es orientativo y no constituye asesoría legal.<br><br>
              <a href="https://www.afiliapp.cl" style="color:#aaa;">afiliapp.cl</a> | contacto@afiliapp.cl | +56 9 3207 6628
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
