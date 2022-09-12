const https = require('https');
const tls = require('tls');
const CosmosClient = require("@azure/cosmos").CosmosClient;
const Gremlin = require('gremlin');
const traversal = Gremlin.process.AnonymousTraversalSource.traversal;
const DriverRemoteConnection = Gremlin.driver.DriverRemoteConnection;
const ArangoDatabase = require('arangojs').Database;

function requestInterceptor(httpModule){
    var original = httpModule.request
    httpModule.request = function(options, callback){
      //console.log("https://"+options.hostname+options.path, options.method)
      let token = Buffer.from(process.env.ARANGO_USER + ":" + process.env.ARANGO_SECRET).toString('base64');
      if(!(options.headers.authorization || options.headers.Authorization)) {
        options.headers.Authorization="Basic "+ token;
      }
      //console.log(JSON.stringify(options.headers))
      return original(options, callback)
    }
}
requestInterceptor(https)

class DbPerfTest {

  testQueries = [
    {
      name:"Document",
      cosmos:"SELECT c.id_nemo, count(1) as count_switch_fields FROM c join t in c.switch_panels where array_length(t.switch_fields) >= 2 and c.asset_type = 'secondary_substation' group by c.id_nemo",
      //arango:'for sec in secondary_substation COLLECT id_nemo = sec.id_nemo , switch_fields = COUNT_DISTINCT(sec.switch_panels[*].switch_fields[*]) filter switch_fields >=2 Limit 30 RETURN {"id_nemo": id_nemo, "count_switch_fields": switch_fields}'
      arango:'for sec in secondary_substation COLLECT id_nemo = sec.id_nemo , switch_fields = COUNT_DISTINCT(FLATTEN(sec.switch_panels[*].switch_fields)) filter switch_fields >=2 Limit 30 RETURN {"id_nemo": id_nemo, "count_switch_fields": switch_fields}'
    },
    {
      name:"Geo",
      cosmos:'SELECT f._id FROM f WHERE ST_WITHIN(f.geometry, {"type": "Polygon", "coordinates":[[[30,45],[35,45],[35,55],[30,55], [30,45]]]}) and f.asset_type = "lv_cable"',
      arango:'LET segment = {"type": "Polygon","coordinates": [[[30,45],[35,45],[35,55],[30,55], [30,45]]]} FOR asset IN lv_cable FILTER GEO_CONTAINS(segment, asset.geometry) return asset'
    },
    {
      name:"Document and Geo",
      cosmos:'SELECT f._id, t.configuration FROM f join t in f.switch_panels where not is_null(t.configuration) and t.configuration != "KT" and t.configuration != "KKT" and t.configuration != "ET" and t.configuration != "KK" and t.configuration != "KKK" and ST_WITHIN(f.geometry, {"type": "Polygon", "coordinates":[[[30,45],[35,45],[35,55],[30,55], [30,45]]]})',
      arango:'LET segment = {"type": "Polygon", "coordinates": [[[30,45],[35,45],[35,55],[30,55], [30,45]]]} FOR a IN secondary_substation FILTER GEO_INTERSECTS(segment, a.geometry) FILTER a.switch_panels[0].configuration != "KT" FILTER a.switch_panels[0].configuration != Null FILTER a.switch_panels[0].configuration != "KKT" FILTER a.switch_panels[0].configuration != "ET" FILTER a.switch_panels[0].configuration != "KK" FILTER a.switch_panels[0].configuration != "KKK" return a'
    },
    {
      name:"Graph Query", 
      //gremlin:"g.V().hasLabel('secondary_substation').has('_id', within('secondary_substation/4d9c5f5097ff2ac9b615c12d9d0e2c06b6c6c269','secondary_substation/8d94e7559358e4cbef7ce700fd24ae23ca78149e')).inE().outV().out().has('asset_type', within('lv_cable', 'lv_overheadline','secondary_substation','lv_switch','lv_joint','cabinet','terminal_point','service_connection')).values('_id')",
      gremlin:"g.V().has('_id', within('secondary_substation/0233521a4c400a2b8492e97ec840082872f96df7', 'secondary_substation/03639a8512bb0bc343b6101ee8607f3f257dddbe')).both('relation').emit().repeat(both('relation').simplePath().has('asset_type', within('lv_cable', 'lv_overheadline','secondary_substation','lv_switch','lv_joint','cabinet','terminal_point','service_connection'))).until(has('asset_type', within('terminal_point', 'secondary_substation')).or().loops().is(31)).values('_id')",
      //arango:'LET LV =  ["lv_cable", "lv_overheadline", "secondary_substation","lv_switch", "lv_joint", "cabinet", "terminal_point", "service_connection"] for s in secondary_substation Filter s._id in ["secondary_substation/4d9c5f5097ff2ac9b615c12d9d0e2c06b6c6c269", "secondary_substation/8d94e7559358e4cbef7ce700fd24ae23ca78149e"] for w, ee, pp in 1..1 ANY s._id Graph relation for v,e,p in 0..100 ANY w._id Graph relation Prune v.asset_type in ["terminal_point", "secondary_substation"] OPTIONS {uniqueVertices: "global", bfs: true} FILTER (p.vertices[*].asset_type all in LV ) RETURN v._id'
      arango:'LET LV =  ["lv_cable", "lv_overheadline", "secondary_substation","lv_switch", "lv_joint", "cabinet", "terminal_point", "service_connection"] for s in secondary_substation Filter s._id in ["secondary_substation/0233521a4c400a2b8492e97ec840082872f96df7", "secondary_substation/03639a8512bb0bc343b6101ee8607f3f257dddbe"] for w, ee, pp in 1..1 ANY s._id Graph relation for v,e,p in 0..100 ANY w._id Graph relation Prune v.asset_type in ["terminal_point", "secondary_substation"] OPTIONS {uniqueVertices: "global", bfs: true} FILTER (p.vertices[*].asset_type all in LV ) RETURN v._id'
    },
  ];

  constructor(config) {
    this.config = config;
  }
  
  async init() {
    console.log("this.config.gremlinEndpoint = " + this.config.gremlinEndpoint);
    this.coreAPIClient = new CosmosClient({endpoint:this.config.endpoint, key:this.config.primaryKey});
    this.cosmosDatabase = this.coreAPIClient.database(this.config.database);
    this.cosmosContainer = this.cosmosDatabase.container(this.config.collection);
    
    //let authenticator = new Gremlin.driver.auth.PlainTextSaslAuthenticator(`/dbs/${this.config.database}/colls/${this.config.collection}`, this.config.gremlinPrimaryKey)
    let gremlinUser = `/dbs/${this.config.database}/colls/${this.config.collection}`;
    let gremlinKey = this.config.gremlinPrimaryKey;
    let authenticator = new Gremlin.driver.auth.PlainTextSaslAuthenticator(gremlinUser, gremlinKey)
    this.gremlinClient = new Gremlin.driver.Client(
        this.config.gremlinEndpoint, 
        { 
            authenticator: authenticator,
            traversalsource : "g",
            rejectUnauthorized : true,
            mimeType : "application/vnd.gremlin-v2.0+json"
        }
    );  
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = 0;
    try {
      this.arangodb = new ArangoDatabase({
        url: 'https://127.0.0.1:8529',
        databaseName:'test1',
        auth: {username:process.env.ARANGO_USER, password:process.env.ARANGO_SECRET},
        agentOptions: {checkServerIdentity : (host, cert) => {
          //console.log("server identity check for " + JSON.stringify(host) + ", " + cert);
          //console.log("tls res: ", tls.checkServerIdentity(host, cert));
          return new Array(0)[1];
        }}
      });
      console.log("trying to connect");
      let desc = await this.arangodb.get();
      console.log("connected to arango: " + JSON.stringify(desc));
    }
    catch(e) {
      console.log("failed connecting to arango: ", e);
      process.exit(1);
    }
     
  }

  async testGraph() {
    console.log("init");
    await this.init();
    console.log("running test queries");
    let res = null;
    try {
      res = await this.runTestQuery("cosmos", this.testQueries[3]);
      console.log("res=" + JSON.stringify(res, null, 2));
    }
    catch(e) {
      console.log(e);
    }
  }
  
  async test() {
    console.log("init");
    await this.init();
    console.log("running test queries");
    let gres = {};
    for(let dbms of ['cosmos', 'arango']) {
    //for(let dbms of ['arango']) {
      for(let exponent = 0; exponent < 7; exponent++) {
        let parallelism = Math.pow(2,exponent);
        console.log("testing parallelism " + parallelism);
        for(let tq of this.testQueries) {
          let res = await this.runTestQueryParallel(dbms, tq, parallelism);
          let qres = gres[tq.name];
          if(!qres)qres=gres[tq.name] = {};
          let dbmsres = qres[dbms];
          if(!dbmsres)dbmsres = qres[dbms] = {};
          dbmsres[""+parallelism] = res;
        }
      }
    }
    
    console.log("finished tests");
    console.log(JSON.stringify(gres,null,2));
    await this.cleanup();
    return;
  }
  
  async cleanup() {
    //await this.gremlinClient.close();
    //console.log("gremlin client closed.");
  }
  
  async runTestQuery(dbms, tq) {
    try {
      if(dbms == "arango") {
        let cursor = await this.arangodb.query(tq.arango);
        //console.log("cursor " + typeof(cursor));
        //console.log("cursor keys:" + Object.keys(cursor));
        //console.log("cursor values:" + Object.values(cursor));
        console.log("extra: " + JSON.stringify(cursor.extra));
        let results = await cursor.all(); // read all results

        //console.log("results: " + JSON.stringify(results));
        console.log("count: " + results.length);
        let execTimeMillis = cursor.extra.stats.executionTime*1000;
        console.log("execTimeMillis: " + execTimeMillis);
        return {
            status:200,
            totalTimeMillis:cursor.extra.stats.executionTime*1000,
            numResults:results.length,
            ruCharge:0
        };
      }
      if(dbms == "cosmos") {
        if(tq.gremlin) {
          console.log("executing gremlin query: " + tq.gremlin);
          let gremlinResult =  await this.gremlinClient.submit(tq.gremlin);
          //console.log("Result: %s\n", JSON.stringify(gremlinResult));
          return {
            status:gremlinResult.attributes["x-ms-status-code"],
            totalTimeMillis:gremlinResult.attributes["x-ms-total-server-time-ms"],
            numResults:gremlinResult.length,
            ruCharge:gremlinResult.attributes["x-ms-total-request-charge"]
          };
        }
        else {
          let querySpec = {query: tq.cosmos};

          let result = await this.cosmosContainer.items
            .query(querySpec, {populateQueryMetrics:true})
            .fetchAll();
          //console.log("Cosmos result: " + JSON.stringify(result));
          return {
            status:200,
            ruCharge:result.headers["x-ms-request-charge"], 
            totalTimeMillis: result.headers["x-ms-documentdb-query-metrics"]["0"].totalQueryExecutionTime["_ticks"] / 10000.0,
            numResults: result.headers["x-ms-documentdb-query-metrics"]["0"].outputDocumentCount
          };
        }
      }
    }
    catch(e) {
      console.log("runTestQuery(" + dbms + "," + tq.name + ") failed: ", e);
      return {error:""+e};
    }
  }
  
  async runTestQueryParallel(dbms, tq, parallelism) {
    let start = new Date();
    let promises = [];
    for(let i = 0; i < parallelism; i++) {
      promises.push(this.runTestQuery(dbms, tq));
    }
    let results = await Promise.all(promises);
    let durationMillis = new Date().getTime()-start.getTime();
    let res = {totalDurationMillis:durationMillis, parallelQueries:parallelism};
    let avgExecMillis = 0;
    let avgRuCharge = 0;
    let avgResultCount = 0;
    console.log("iterating " + results.length + " results...");
    for(let r of results) {
      console.log("result: " + JSON.stringify(r));
      avgExecMillis += r.totalTimeMillis;
      if(r.ruCharge) avgRuCharge += r.ruCharge;
      avgResultCount += r.numResults;
    }
    if(avgExecMillis>0)avgExecMillis /= results.length;
    if(avgRuCharge>0)avgRuCharge /= results.length;
    if(avgResultCount>0)avgResultCount /= results.length;
    res.avgDurationMillis = avgExecMillis;
    res.avgRuCharge = avgRuCharge;
    res.avgResultCount = avgResultCount;
    res.dbms = dbms;
    res.query = tq.name;
    console.log("Results("+dbms+","+tq.name+"): " + JSON.stringify(res));
    return res;
  }
}

//console.log("args: " + JSON.stringify(process.argv));
if(process.argv.length > 2 || process.argv[2] == "test") {
  runTest();
}

async function runTest() {
  console.log("running test");
  let config = {}

  config.gremlinEndpoint = "wss://"+ process.env.GREMLIN_DATABASE_ACCOUNT_NAME + ".gremlin.cosmos.azure.com:443/gremlin";
  //config.gremlinEndpoint = "wss://"+ process.env.GREMLIN_DATABASE_ACCOUNT_NAME + ".gremlin.cosmos.azure.com:443/";
  config.gremlinPrimaryKey = process.env.GREMLIN_PRIMARY_KEY;
  config.endpoint = "https://"+process.env.DATABASE_ACCOUNT_NAME + ".documents.azure.com:443/";
  config.primaryKey = process.env.PRIMARY_KEY;
  config.database = "nemo"
  config.collection = "nemo"
  let pt = new DbPerfTest(config);
  await pt.test();
  //await pt.testGraph();
  process.exit(0);
}