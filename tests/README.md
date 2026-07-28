# Tests

`searchable_service.spec.ts` es la suite de contrato del paquete: corre con
Japa contra una base Postgres real y modelos Lucid, así que vive en el
proyecto consumidor (el chasis `adonis7-base`) donde ya existe ese entorno.

Se conserva aquí como referencia del comportamiento esperado — cualquier
cambio del paquete debe seguir pasándola en el consumidor antes de publicar
una versión nueva.
