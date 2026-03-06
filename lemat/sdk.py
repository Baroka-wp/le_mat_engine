"""
LEMAT — SDK Generator
Génère le SDK JavaScript client pour un projet donné.
"""
from __future__ import annotations

from typing import Optional
import model_parser


def _sdk_mail_js(project: str) -> str:
    """Bloc JS Mail.send partagé entre les deux variantes de SDK."""
    return f"""    /** Send an email via the project SMTP config.
     *  @param {{ to, subject, html, text, from_name, from_email }} opts
     *  @returns Promise<{{ sent: true, recipients: string[] }}>
     */
    Mail: {{
      send: function(opts) {{
        return fetch('/api/projects/{project}/mail/send', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify(opts),
        }}).then(function(r) {{
          if (!r.ok) return r.json().then(function(e) {{ return Promise.reject(e); }});
          return r.json();
        }});
      }},
    }},"""


def generate_sdk(project: str, schema: Optional[model_parser.SchemaDef]) -> str:
    """Génère le SDK complet si un schéma est disponible, sinon le SDK minimal."""
    if not schema or not schema.models:
        return generate_empty_sdk(project)

    model_lines = [f"  {m.name}: _model('{m.name}')," for m in schema.models]

    return f"""// LEMAT SDK — auto-generated for project "{project}"
// Models: {', '.join(m.name for m in schema.models)}
// Usage:  const users = await LeMat.User.all();
//         const u = await LeMat.User.create({{ name: 'Alice' }});
//         await LeMat.User.update(1, {{ name: 'Bob' }});
//         await LeMat.User.delete(1);

(function (w) {{
  'use strict';
  var BASE = '/api/projects/{project}/data';

  function _req(method, path, body) {{
    var opts = {{ method: method, headers: {{}} }};
    if (body !== undefined) {{
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }}
    return fetch(BASE + path, opts).then(function (r) {{
      if (!r.ok) return r.json().then(function (e) {{ return Promise.reject(e); }});
      return r.json();
    }});
  }}

  function _model(name) {{
    return {{
      /** Fetch all rows. Optional params: {{ limit, offset, order_by, ...filters }} */
      all: function (params) {{
        var qs = params ? '?' + new URLSearchParams(params).toString() : '';
        return _req('GET', '/' + name + qs);
      }},
      /** Fetch one row by primary key. */
      find: function (id) {{ return _req('GET', '/' + name + '/' + id); }},
      /** Create a new row. */
      create: function (data) {{ return _req('POST', '/' + name, data); }},
      /** Update a row by primary key. */
      update: function (id, data) {{ return _req('PUT', '/' + name + '/' + id, data); }},
      /** Delete a row by primary key. */
      delete: function (id) {{ return _req('DELETE', '/' + name + '/' + id); }},
    }};
  }}

  w.LeMat = {{
{chr(10).join(model_lines)}
{_sdk_mail_js(project)}
  }};
}})(window);
"""


def generate_empty_sdk(project: str = "") -> str:
    """SDK minimal sans modèles (Mail seulement)."""
    return f"""// LEMAT SDK — project "{project}"
(function(w) {{
  'use strict';
  w.LeMat = {{
{_sdk_mail_js(project)}
  }};
}})(window);
"""
