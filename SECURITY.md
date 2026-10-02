# Seguridad

La versión 0.1.0-beta.2 recibe correcciones de seguridad; todavía no hay compromiso de soporte de versiones anteriores ni un SLA de respuesta.

Comunica una posible vulnerabilidad mediante el [formulario privado de GitHub](https://github.com/IgorPrieto/api-patch/security/advisories/new). Incluye versión, impacto, pasos mínimos de reproducción y si implica lectura/escritura fuera del workspace, ejecución de código o exposición de secretos. No publiques detalles explotables en issues o discusiones.

APIPatch analiza repositorios sin ejecutar su código. La aplicación de parches y las pruebas del repositorio requieren acciones explícitas. El panel escucha en loopback y restringe rutas al workspace elegido; aun así, no uses una beta como garantía de seguridad o compatibilidad de producción.
