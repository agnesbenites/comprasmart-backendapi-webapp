// backend/utils/supabaseClient.js (CommonJS)
const { createClient } = require("@supabase/supabase-js");
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_ANON_KEY;

// Debug: verificar se as variáveis estão sendo carregadas
console.log('🔍 Debug Supabase:');
console.log('SUPABASE_URL:', supabaseUrl ? '✅ Configurada' : '❌ NÃO ENCONTRADA');
console.log('SUPABASE_ANON_KEY:', supabaseSecretKey ? '✅ Configurada' : '❌ NÃO ENCONTRADA');

if (!supabaseUrl || !supabaseSecretKey) {
  console.error('❌ ERRO: Variáveis de ambiente do Supabase não configuradas!');
  console.error('Certifique-se de que SUPABASE_URL e SUPABASE_ANON_KEY estão no Render Dashboard');
}

// Para chamadas de servidor (Node.js), usamos a chave secreta de administrador.
const supabase = createClient(supabaseUrl, supabaseSecretKey);

module.exports = supabase;