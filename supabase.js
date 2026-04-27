const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("❌ SUPABASE_URL ou SUPABASE_SERVICE_KEY não definidos");
}

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
