"""Conexión con Eco-Rewards (Supabase): cuentas, rostros, máquina y sesiones.

Usa la misma base que la app web. Los vectores de buffalo_l viven en
face_embeddings. Una sesión source='face' la toma la ESP32 con poll-session,
igual que el código QR, y los puntos van a la cuenta de esa persona.
"""
import os
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import requests

TIMEOUT = 20
SESION_SEGUNDOS = int(os.environ.get("SESION_SEGUNDOS", "60"))
MODELO = "insightface/buffalo_l"
EMBED_DIM = 512


def _cfg():
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
    code = os.environ.get("MACHINE_CODE", "").strip().upper()
    return url, key, code


def configurado() -> bool:
    url, key, code = _cfg()
    return bool(url and key and code)


def _headers(extra=None):
    _, key, _ = _cfg()
    h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if extra:
        h.update(extra)
    return h


def _rest(path):
    url, _, _ = _cfg()
    return f"{url}/rest/v1/{path}"


def _check(respuesta, accion):
    if not respuesta.ok:
        raise RuntimeError(f"{accion}: {respuesta.status_code} {respuesta.text[:400]}")


def _get(tabla, params):
    r = requests.get(_rest(tabla), headers=_headers(), params=params, timeout=TIMEOUT)
    _check(r, f"leer {tabla}")
    return r.json()


def _ahora():
    return datetime.now(timezone.utc).isoformat()


def nombre(perfil) -> str:
    if not perfil:
        return "Reciclador"
    return (perfil.get("alias") or "").strip() or (perfil.get("full_name") or "").strip() or "Reciclador"


# ---------------------------------------------------------------- cuentas

_CAMPOS = "id,email,alias,full_name,account_number,points_balance"


def buscar_perfil(cuenta: str):
    """Busca la cuenta por correo o por número de cuenta."""
    cuenta = cuenta.strip()
    if "@" in cuenta:
        filtro = {"email": f"eq.{cuenta.lower()}"}
    else:
        filtro = {"account_number": f"eq.{cuenta}"}
    filas = _get("profiles", {**filtro, "select": _CAMPOS})
    return filas[0] if filas else None


def perfil_por_id(profile_id: str):
    filas = _get("profiles", {"id": f"eq.{profile_id}", "select": _CAMPOS})
    return filas[0] if filas else None


# ---------------------------------------------------------------- máquina y sesiones

def obtener_maquina():
    _, _, code = _cfg()
    filas = _get("machines", {
        "machine_code": f"eq.{code}",
        "is_active": "eq.true",
        "select": "id,machine_code,name",
    })
    if not filas:
        raise SystemExit(f"No existe una máquina activa con MACHINE_CODE={code}")
    return filas[0]


def sesion_activa(machine_id: str):
    filas = _get("recycling_sessions", {
        "machine_id": f"eq.{machine_id}",
        "status": "eq.armed",
        "expires_at": f"gt.{_ahora()}",
        "select": "id,user_id,source,expires_at,items_processed",
        "order": "armed_at.desc",
        "limit": "1",
    })
    return filas[0] if filas else None


def abrir_sesion(machine_id: str, profile_id: str):
    """Igual que escanear el QR, pero con source='face'."""
    if sesion_activa(machine_id):
        return None
    requests.patch(
        _rest("recycling_sessions"),
        headers=_headers(),
        params={"status": "eq.armed", "or": f"(user_id.eq.{profile_id},machine_id.eq.{machine_id})"},
        json={"status": "cancelled"},
        timeout=TIMEOUT,
    ).raise_for_status()

    vence = datetime.now(timezone.utc) + timedelta(seconds=SESION_SEGUNDOS)
    r = requests.post(
        _rest("recycling_sessions"),
        headers=_headers({"Prefer": "return=representation"}),
        json={
            "machine_id": machine_id,
            "user_id": profile_id,
            "status": "armed",
            "source": "face",
            "expires_at": vence.isoformat(),
        },
        timeout=TIMEOUT,
    )
    _check(r, "abrir sesión")
    return r.json()[0]


def terminar_sesion(session_id: str):
    r = requests.patch(
        _rest("recycling_sessions"),
        headers=_headers(),
        params={"id": f"eq.{session_id}", "status": "eq.armed"},
        json={"status": "completed"},
        timeout=TIMEOUT,
    )
    _check(r, "terminar sesión")


# ---------------------------------------------------------------- rostros

def _perfil_anidado(fila):
    perfil = fila.get("profiles")
    if isinstance(perfil, list):
        perfil = perfil[0] if perfil else None
    return perfil or {}


def listar_rostros():
    """Una fila por muestra: user_id, embedding (512), nombre y cuenta."""
    filas = _get("face_embeddings", {
        "model": f"eq.{MODELO}",
        "select": "user_id,embedding,profiles(alias,full_name,account_number)",
    })
    personas = []
    for fila in filas:
        emb = fila.get("embedding") or []
        if len(emb) != EMBED_DIM:
            continue
        perfil = _perfil_anidado(fila)
        personas.append({
            "user_id": fila["user_id"],
            "cuenta": perfil.get("account_number") or fila["user_id"],
            "nombre": nombre(perfil),
            "embedding": emb,
        })
    return personas


def reemplazar_embeddings(user_id: str, embeddings):
    """Sustituye las muestras de una persona y marca el consentimiento."""
    r = requests.delete(
        _rest("face_embeddings"),
        headers=_headers(),
        params={"user_id": f"eq.{user_id}"},
        timeout=TIMEOUT,
    )
    _check(r, "borrar vectores anteriores")

    filas = [{
        "user_id": user_id,
        "model": MODELO,
        "embedding": [round(float(v), 6) for v in emb],
    } for emb in embeddings]
    r = requests.post(_rest("face_embeddings"), headers=_headers(), json=filas, timeout=TIMEOUT)
    _check(r, "guardar vectores")

    r = requests.patch(
        _rest("profiles"),
        headers=_headers(),
        params={"id": f"eq.{user_id}"},
        json={"face_consent_at": _ahora()},
        timeout=TIMEOUT,
    )
    _check(r, "guardar consentimiento")


def borrar_rostro(user_id: str):
    r = requests.delete(
        _rest("face_embeddings"),
        headers=_headers(),
        params={"user_id": f"eq.{user_id}"},
        timeout=TIMEOUT,
    )
    _check(r, "borrar rostro")
    r = requests.patch(
        _rest("profiles"),
        headers=_headers(),
        params={"id": f"eq.{user_id}"},
        json={"face_consent_at": None},
        timeout=TIMEOUT,
    )
    _check(r, "quitar consentimiento")


def trabajos_pendientes():
    return _get("face_enrollment_jobs", {
        "status": "eq.pending",
        "select": "id,user_id,storage_paths",
        "order": "created_at.asc",
    })


def cerrar_trabajo(job_id: str, status: str, error: str | None = None):
    r = requests.patch(
        _rest("face_enrollment_jobs"),
        headers=_headers(),
        params={"id": f"eq.{job_id}"},
        json={"status": status, "error": error},
        timeout=TIMEOUT,
    )
    _check(r, "cerrar trabajo de registro")


def descargar_foto(path: str) -> bytes:
    url, _, _ = _cfg()
    ruta = quote(path, safe="/")
    r = requests.get(
        f"{url}/storage/v1/object/face-inbox/{ruta}",
        headers=_headers(),
        timeout=TIMEOUT,
    )
    _check(r, f"descargar {path}")
    return r.content


def borrar_fotos(paths):
    if not paths:
        return
    url, _, _ = _cfg()
    r = requests.delete(
        f"{url}/storage/v1/object/face-inbox",
        headers=_headers(),
        json={"prefixes": list(paths)},
        timeout=TIMEOUT,
    )
    _check(r, "borrar fotos temporales")


def peticiones_pendientes(machine_id: str):
    return _get("face_requests", {
        "machine_id": f"eq.{machine_id}",
        "status": "eq.pending",
        "expires_at": f"gt.{_ahora()}",
        "select": "id,user_id,expires_at",
        "order": "created_at.asc",
    })


def expirar_peticiones(machine_id: str):
    r = requests.patch(
        _rest("face_requests"),
        headers=_headers(),
        params={
            "machine_id": f"eq.{machine_id}",
            "status": "eq.pending",
            "expires_at": f"lt.{_ahora()}",
        },
        json={"status": "expired", "error": "Tiempo agotado"},
        timeout=TIMEOUT,
    )
    _check(r, "expirar peticiones")


def cerrar_peticion(request_id: str, status: str, session_id: str | None = None, error: str | None = None):
    cuerpo = {"status": status, "error": error}
    if session_id:
        cuerpo["session_id"] = session_id
    r = requests.patch(
        _rest("face_requests"),
        headers=_headers(),
        params={"id": f"eq.{request_id}", "status": "eq.pending"},
        json=cuerpo,
        timeout=TIMEOUT,
    )
    _check(r, "cerrar petición de rostro")
