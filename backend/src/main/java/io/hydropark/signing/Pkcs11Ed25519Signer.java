package io.hydropark.signing;

import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Provider;
import java.security.Security;
import java.security.Signature;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A <b>gated skeleton</b> {@link Signer} for a hardware HSM that signs Ed25519 over PKCS#11
 * (BACKLOG P1-16.8, migration option (a)). It is <em>not</em> the default and does <em>not</em> run
 * unless {@code hydropark.signing.provider=pkcs11}.
 *
 * <p><b>Why this is the realistic path, not a cloud KMS.</b> As of the design's verification
 * (Microsoft Managed HSM supported-algorithms docs, 2026-06) <b>no major cloud KMS/HSM signs
 * Ed25519</b>: Azure Managed HSM lists only RSA / EC (P-256/384/521) / AES with sign limited to
 * ES*, PS*, RS*, HS* — no OKP key type, no Ed25519 curve, no EdDSA algorithm; AWS KMS and GCP KMS are
 * the same. Hardware HSMs that expose EdDSA over PKCS#11 (YubiHSM 2, Thales Luna, Entrust nShield)
 * are the only way to keep the Ed25519 token format while moving the private key out of process
 * memory. See {@code docs/HSM-MIGRATION.md}.
 *
 * <p><b>What is real here vs. stubbed.</b> The integration points are complete and real:
 *
 * <ol>
 *   <li>the config surface ({@link SigningProperties.Pkcs11}: library, slot/tokenLabel, pin, per-kid
 *       object labels, the JCA algorithm name);
 *   <li>the {@code kid → PKCS#11 object label} resolution;
 *   <li>the provider bootstrap ({@code SunPKCS11} configured from a file or synthesized inline
 *       config — the JDK-9+ {@link Provider#configure(String)} path);
 *   <li>the sign path itself: open the PKCS#11 {@link KeyStore}, fetch the private-key <em>handle</em>
 *       (never the bytes — the key stays in the HSM), and call {@code Signature.sign()} which drives
 *       {@code C_Sign} on the device.
 * </ol>
 *
 * The only thing missing is a real token to talk to: with no library/config set, {@link #sign} throws
 * {@link UnsupportedOperationException}. Finishing P1-16.8 is therefore a <b>config + driver</b> task
 * (install the vendor {@code .so}, provision the key, set {@code hydropark.signing.pkcs11.*}), not a
 * redesign. The provider-load and sign code below has not been exercised against physical hardware.
 *
 * <p>The active key's <b>public</b> half still comes from {@code hydropark.licensing.keys} (it must
 * ship in every app's trusted set, §6.3) and is handed in as {@code activeKey}; only the private
 * operation moves into the token.
 */
public final class Pkcs11Ed25519Signer implements Signer {

  private static final Logger log = LoggerFactory.getLogger(Pkcs11Ed25519Signer.class);

  private final SigningKeyRef activeKey;
  private final SigningProperties.Pkcs11 cfg;

  // Lazily initialised on first sign so the bean can exist (and the app boot) even before a token is
  // reachable — the failure surfaces at sign time with a clear, actionable message.
  private volatile Provider provider;
  private volatile KeyStore keyStore;

  public Pkcs11Ed25519Signer(SigningKeyRef activeKey, SigningProperties.Pkcs11 cfg) {
    if (activeKey == null) {
      throw new IllegalArgumentException("activeKey is required (its public half ships in apps)");
    }
    this.activeKey = activeKey;
    this.cfg = cfg;
  }

  @Override
  public SigningKeyRef activeKey() {
    return activeKey;
  }

  @Override
  public byte[] sign(byte[] signingInput, SigningKeyRef key) {
    if (!cfg.isConfigured()) {
      throw new UnsupportedOperationException(
          "configure a PKCS#11 provider — see docs/HSM-MIGRATION.md "
              + "(set hydropark.signing.pkcs11.library or .configPath, then the token slot/label, "
              + "pin, and the kid→object-label map)");
    }
    try {
      KeyStore ks = keyStore();
      String label = cfg.getKeyLabels().getOrDefault(key.kid(), key.kid());

      // The returned PrivateKey is a HANDLE into the token, not exportable key bytes. The material
      // never enters app memory — the whole point of moving to hardware custody.
      PrivateKey handle = (PrivateKey) ks.getKey(label, pin());
      if (handle == null) {
        throw new IllegalStateException(
            "no PKCS#11 private-key object labelled '" + label + "' for kid=" + key.kid());
      }

      Signature s = Signature.getInstance(cfg.getSignatureAlgorithm(), provider());
      s.initSign(handle);
      s.update(signingInput); // C_SignUpdate / buffered
      return s.sign(); //        C_Sign on the HSM → raw Ed25519 signature bytes
    } catch (UnsupportedOperationException | IllegalStateException e) {
      throw e;
    } catch (Exception e) {
      // Never echo key material or the PIN.
      throw new IllegalStateException("PKCS#11 Ed25519 signing failed for kid=" + key.kid(), e);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Provider / keystore bootstrap. Real SunPKCS11 wiring, gated by isConfigured() above.
  // ---------------------------------------------------------------------------------------------

  private Provider provider() {
    Provider p = provider;
    if (p == null) {
      synchronized (this) {
        p = provider;
        if (p == null) {
          Provider base = Security.getProvider("SunPKCS11");
          if (base == null) {
            throw new IllegalStateException(
                "SunPKCS11 provider is unavailable in this JRE — cannot use the PKCS#11 signer");
          }
          // JDK 9+: configure(String) takes either a config-file path or an inline "--" config and
          // returns a NEW configured provider instance; it does not mutate the shared one.
          p = base.configure(configArgument());
          Security.addProvider(p);
          provider = p;
          log.info("initialised PKCS#11 provider {} for the license signer", p.getName());
        }
      }
    }
    return p;
  }

  /**
   * Either the operator-supplied config-file path, or a synthesized inline config (JDK-9+ accepts a
   * leading {@code --} to mean "the argument is the config text, not a path").
   */
  private String configArgument() {
    if (!cfg.getConfigPath().isBlank()) {
      return cfg.getConfigPath();
    }
    StringBuilder sb = new StringBuilder("--");
    sb.append("name = ").append(cfg.getName()).append('\n');
    sb.append("library = ").append(cfg.getLibrary()).append('\n');
    if (!cfg.getSlot().isBlank()) {
      sb.append("slot = ").append(cfg.getSlot()).append('\n');
    }
    if (!cfg.getTokenLabel().isBlank()) {
      sb.append("tokenLabel = ").append(cfg.getTokenLabel()).append('\n');
    }
    return sb.toString();
  }

  private KeyStore keyStore() throws Exception {
    KeyStore ks = keyStore;
    if (ks == null) {
      synchronized (this) {
        ks = keyStore;
        if (ks == null) {
          ks = KeyStore.getInstance("PKCS11", provider());
          ks.load(null, pin()); // the PIN logs the session into the token
          keyStore = ks;
        }
      }
    }
    return ks;
  }

  private char[] pin() {
    String p = cfg.getPin();
    return (p == null || p.isEmpty()) ? null : p.toCharArray();
  }
}
